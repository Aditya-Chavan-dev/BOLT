import fs from 'node:fs';
import path from 'node:path';
import { extractFileDiffLines, applyUnifiedDiffToText } from '../git-diff.mjs';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
]);

const SEARCH_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.jsx',
  '.tsx',
  '.vue',
  '.svelte',
  '.json',
]);

/**
 * Resolves the effective package.json data by applying any unified diff modifications
 * to the base file on disk without mutating the filesystem.
 *
 * @param {string} repositoryRoot
 * @param {object} diffResult
 * @returns {{ success: boolean, data?: object, error?: string }}
 */
export function getEffectivePackageJson(repositoryRoot, diffResult) {
  const pkgPath = path.resolve(repositoryRoot, 'package.json');
  let baseContent = null;
  if (fs.existsSync(pkgPath)) {
    try {
      baseContent = fs.readFileSync(pkgPath, 'utf8');
    } catch {
      // unreadable
    }
  }

  const pkgDiffFile = diffResult?.changedFiles?.find(
    (f) => f.path === 'package.json' || f.path.endsWith('/package.json')
  );

  // If package.json was not modified in the diff
  if (!pkgDiffFile) {
    if (baseContent !== null) {
      try {
        const data = JSON.parse(baseContent);
        return { success: true, data };
      } catch (err) {
        return { success: false, error: `Malformed package.json on disk: ${err.message}` };
      }
    }
    return { success: false, error: "File 'package.json' does not exist in repository root." };
  }

  // If this is a standard git review (working tree on disk already updated)
  if (!diffResult?.isDirectDiff) {
    if (baseContent !== null) {
      try {
        const data = JSON.parse(baseContent);
        return { success: true, data };
      } catch (err) {
        return { success: false, error: `Malformed package.json on disk: ${err.message}` };
      }
    }
    return { success: false, error: "File 'package.json' does not exist in repository root." };
  }

  // Direct diff mode: diff has not necessarily been applied to disk
  const diffLines = extractFileDiffLines(diffResult?.diffText, pkgDiffFile.path);

  if (diffLines.length === 0 && pkgDiffFile.addedLines && pkgDiffFile.addedLines.length > 0) {
    if (pkgDiffFile.status === 'added' || baseContent === null) {
      const syntheticText = pkgDiffFile.addedLines.map((l) => l.content).join('\n');
      try {
        const data = JSON.parse(syntheticText);
        return { success: true, data };
      } catch (err) {
        return { success: false, error: `Incomplete or malformed package.json diff: ${err.message}` };
      }
    }
  }

  if (diffLines.length === 0) {
    return { success: false, error: 'Incomplete or malformed package.json diff: no diff hunks found for package.json' };
  }

  const applyRes = applyUnifiedDiffToText(baseContent || '', diffLines);
  if (!applyRes.success) {
    if (baseContent !== null) {
      try {
        const diskData = JSON.parse(baseContent);
        const hasAllAdded = pkgDiffFile.addedLines.every((l) => {
          const match = l.content.match(/^"(@?[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?)":\s*"[^"]+"/);
          if (!match) return true;
          const pkg = match[1];
          return (
            (diskData.dependencies && diskData.dependencies[pkg]) ||
            (diskData.devDependencies && diskData.devDependencies[pkg])
          );
        });
        if (hasAllAdded) {
          return { success: true, data: diskData };
        }
      } catch {
        // fall through to error
      }
    }
    return { success: false, error: `Incomplete or malformed package.json diff: ${applyRes.error}` };
  }

  try {
    const data = JSON.parse(applyRes.text);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: `Incomplete or malformed package.json diff: ${err.message}` };
  }
}

function extractAddedProductionDependencies(packageJsonDiffFile, repositoryRoot, diffResult) {
  if (!packageJsonDiffFile || !Array.isArray(packageJsonDiffFile.addedLines)) {
    return { addedDeps: [], error: null };
  }

  const effectiveResult = getEffectivePackageJson(repositoryRoot, diffResult);
  if (!effectiveResult.success) {
    return { addedDeps: [], error: effectiveResult.error };
  }

  const currentDependencies =
    effectiveResult.data && typeof effectiveResult.data.dependencies === 'object' && effectiveResult.data.dependencies !== null
      ? effectiveResult.data.dependencies
      : {};

  const addedDeps = [];

  for (const item of packageJsonDiffFile.addedLines) {
    const rawContent = item.content.trim();

    // Match package declaration: "package-name": "^1.0.0"
    const match = rawContent.match(/^"(@?[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?)":\s*"[^"]+"/);
    if (match) {
      const packageName = match[1];

      // Strictly confirm package is in production 'dependencies' and not dev/peer/optional
      if (Object.prototype.hasOwnProperty.call(currentDependencies, packageName)) {
        addedDeps.push(
          Object.freeze({
            packageName,
            line: item.line,
            content: rawContent,
          })
        );
      }
    }
  }

  return { addedDeps, error: null };
}

function findSourceFiles(dir, fileList = []) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          findSourceFiles(path.join(dir, entry.name), fileList);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (SEARCH_EXTENSIONS.has(ext)) {
          fileList.push(path.join(dir, entry.name));
        }
      }
    }
  } catch {
    // Gracefully handle unreadable directories
  }
  return fileList;
}

/**
 * Strips single-line, block, and HTML comments from source code while preserving
 * string literals, configuration entries, template literals, and line numbers.
 *
 * @param {string} code
 * @returns {string}
 */
export function stripComments(code) {
  if (typeof code !== 'string') return '';
  let result = '';
  let i = 0;
  const n = code.length;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < n) {
    const ch = code[i];
    const next = i + 1 < n ? code[i + 1] : '';

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        result += ch;
      }
      i++;
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      if (ch === '\n') {
        result += '\n'; // preserve line numbers
      }
      i++;
      continue;
    }

    if (inString) {
      result += ch;
      if (ch === '\\') {
        if (i + 1 < n) {
          result += code[i + 1];
          i += 2;
          continue;
        }
      } else if (ch === inString) {
        inString = null;
      }
      i++;
      continue;
    }

    // Outside comments and strings
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      result += ch;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (ch === '<' && code.slice(i, i + 4) === '<!--') {
      const endIdx = code.indexOf('-->', i + 4);
      if (endIdx !== -1) {
        const commentContent = code.slice(i, endIdx + 3);
        const newlines = (commentContent.match(/\n/g) || []).join('');
        result += newlines;
        i = endIdx + 3;
        continue;
      }
    }

    result += ch;
    i++;
  }

  return result;
}

/**
 * Reconstructs the effective post-diff source state across the repository.
 * In direct-diff mode, applies hunks to on-disk files in memory, excludes deleted/renamed
 * files, and includes newly added files.
 *
 * @param {string} repositoryRoot
 * @param {object} diffResult
 * @returns {{ success: boolean, files?: Array<{ path: string, content: string }>, error?: string }}
 */
export function getEffectiveSourceContents(repositoryRoot, diffResult) {
  const diskFiles = findSourceFiles(repositoryRoot);
  const effectiveFiles = [];

  if (!diffResult?.isDirectDiff) {
    for (const filePath of diskFiles) {
      const relPath = path.relative(repositoryRoot, filePath).replace(/\\/g, '/');
      if (relPath === 'package.json' || relPath.endsWith('/package.json')) continue;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        effectiveFiles.push({ path: relPath, content });
      } catch {
        // Skip unreadable files
      }
    }
    return { success: true, files: effectiveFiles };
  }

  // Direct diff mode
  const changedMap = new Map();
  const deletedOrRenamedPaths = new Set();

  for (const f of diffResult.changedFiles || []) {
    const norm = f.path.replace(/\\/g, '/');
    changedMap.set(norm, f);
    if (f.status === 'D' || f.status === 'deleted') {
      deletedOrRenamedPaths.add(norm);
    }
    if (f.oldPath) {
      deletedOrRenamedPaths.add(f.oldPath.replace(/\\/g, '/'));
    }
  }

  // 1. Process files present on disk
  for (const filePath of diskFiles) {
    const relPath = path.relative(repositoryRoot, filePath).replace(/\\/g, '/');
    if (relPath === 'package.json' || relPath.endsWith('/package.json')) continue;

    if (deletedOrRenamedPaths.has(relPath)) {
      // File deleted or renamed away in diff, exclude pre-diff disk version
      continue;
    }

    if (changedMap.has(relPath)) {
      const fileObj = changedMap.get(relPath);
      if (fileObj.status === 'D' || fileObj.status === 'deleted') {
        continue;
      }
      let baseContent = '';
      try {
        baseContent = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        return { success: false, error: `Could not read base file '${relPath}': ${err.message}` };
      }

      const diffLines = extractFileDiffLines(diffResult.diffText, relPath);
      if (diffLines.length === 0) {
        if (Array.isArray(fileObj.addedLines) && fileObj.addedLines.length > 0) {
          effectiveFiles.push({
            path: relPath,
            content: fileObj.addedLines.map((l) => l.content).join('\n'),
          });
          continue;
        }
        return { success: false, error: `Could not reconstruct post-diff content for modified file '${relPath}': no diff hunks found.` };
      }

      const applyRes = applyUnifiedDiffToText(baseContent, diffLines);
      if (!applyRes.success) {
        return { success: false, error: `Could not reconstruct post-diff content for modified file '${relPath}': ${applyRes.error}` };
      }
      effectiveFiles.push({ path: relPath, content: applyRes.text });
    } else {
      // Untouched file on disk
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        effectiveFiles.push({ path: relPath, content });
      } catch {
        // Skip unreadable files
      }
    }
  }

  // 2. Process added files in diff
  for (const f of diffResult.changedFiles || []) {
    if (f.isBinary) continue;
    const relPath = f.path.replace(/\\/g, '/');
    if (relPath === 'package.json' || relPath.endsWith('/package.json')) continue;
    if (f.status === 'D' || f.status === 'deleted') continue;
    if (effectiveFiles.some((item) => item.path === relPath)) continue;

    const fullPath = path.resolve(repositoryRoot, relPath);
    if (f.status === 'added' || !fs.existsSync(fullPath)) {
      const diffLines = extractFileDiffLines(diffResult.diffText, relPath);
      let newContent = '';
      if (diffLines.length > 0) {
        const applyRes = applyUnifiedDiffToText('', diffLines);
        if (applyRes.success) {
          newContent = applyRes.text;
        } else if (Array.isArray(f.addedLines)) {
          newContent = f.addedLines.map((l) => l.content).join('\n');
        }
      } else if (Array.isArray(f.addedLines)) {
        newContent = f.addedLines.map((l) => l.content).join('\n');
      } else if (f.status === 'renamed' && f.oldPath) {
        const oldFull = path.resolve(repositoryRoot, f.oldPath);
        if (fs.existsSync(oldFull)) {
          try {
            newContent = fs.readFileSync(oldFull, 'utf8');
          } catch {
            newContent = '';
          }
        }
      }
      effectiveFiles.push({ path: relPath, content: newContent });
    }
  }

  return { success: true, files: effectiveFiles };
}

/**
 * Checks whether a package is referenced in the effective source files, ignoring comments.
 *
 * @param {string} packageName
 * @param {Array<{ path: string, content: string }>} effectiveFiles
 * @returns {{ referenced: boolean, referencedIn: string | null }}
 */
export function isPackageReferenced(packageName, effectiveFiles) {
  // Regex matches:
  // - Static import: import ... from 'pkg'
  // - Dynamic import: import('pkg')
  // - CommonJS require: require('pkg')
  // - Configuration / plugin listing: 'pkg' or "pkg"
  const escapedPkg = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const referenceRegex = new RegExp(
    `(?:(?:from\\s+|import\\s*\\(\\s*|require\\s*\\(\\s*)['"]${escapedPkg}(?:/[^'"]*)?['"]|['"]${escapedPkg}['"])`,
    'm'
  );

  for (const file of effectiveFiles) {
    const cleanContent = stripComments(file.content);
    if (referenceRegex.test(cleanContent)) {
      return {
        referenced: true,
        referencedIn: file.path,
      };
    }
  }

  return {
    referenced: false,
    referencedIn: null,
  };
}

/**
 * Deterministically checks for newly added dependencies that are not imported anywhere in the codebase.
 * Enforces RULE-NO-UNNECESSARY-DEPENDENCIES per Section 6 of BLOAT_CHECKER_V1_BUILD_SPEC.md.
 *
 * @param {object} options
 * @param {string} options.repositoryRoot - Repository root directory.
 * @param {object} options.diffResult - Output object from readGitDiff().
 * @returns {{
 *   executed: boolean,
 *   skippedReason: string | null,
 *   violations: ReadonlyArray<object>,
 *   errors: ReadonlyArray<string>
 * }}
 */
export function checkUnusedDependencies(options = {}) {
  const repositoryRoot = options.repositoryRoot ? path.resolve(options.repositoryRoot) : process.cwd();
  const diffResult = options.diffResult;

  if (!diffResult || !Array.isArray(diffResult.changedFiles)) {
    return Object.freeze({
      executed: false,
      skippedReason: 'Invalid or missing diffResult',
      violations: Object.freeze([]),
      errors: Object.freeze(['Missing valid diffResult from readGitDiff()']),
    });
  }

  // Find package.json in changed files
  const packageJsonFile = diffResult.changedFiles.find(
    (f) => f.path === 'package.json' || f.path.endsWith('/package.json')
  );

  if (!packageJsonFile) {
    return Object.freeze({
      executed: false,
      skippedReason: 'package.json was not modified in the evaluated diff range',
      violations: Object.freeze([]),
      errors: Object.freeze([]),
    });
  }

  const { addedDeps, error: depError } = extractAddedProductionDependencies(packageJsonFile, repositoryRoot, diffResult);
  if (depError) {
    return Object.freeze({
      executed: false,
      skippedReason: null,
      violations: Object.freeze([]),
      errors: Object.freeze([depError]),
    });
  }

  if (addedDeps.length === 0) {
    return Object.freeze({
      executed: true,
      skippedReason: null,
      violations: Object.freeze([]),
      errors: Object.freeze([]),
    });
  }

  const effectiveResult = getEffectiveSourceContents(repositoryRoot, diffResult);
  if (!effectiveResult.success) {
    return Object.freeze({
      executed: false,
      skippedReason: null,
      violations: Object.freeze([]),
      errors: Object.freeze([effectiveResult.error]),
    });
  }

  const violations = [];

  for (const dep of addedDeps) {
    const usage = isPackageReferenced(dep.packageName, effectiveResult.files);
    if (!usage.referenced) {
      violations.push(
        Object.freeze({
          ruleId: 'RULE-NO-UNNECESSARY-DEPENDENCIES',
          packageName: dep.packageName,
          filePath: packageJsonFile.path,
          line: dep.line,
          evidence: dep.content,
          details: `Package '${dep.packageName}' was added to production dependencies in ${packageJsonFile.path}:${dep.line} with zero import, require, or configuration references across the codebase.`,
        })
      );
    }
  }

  return Object.freeze({
    executed: true,
    skippedReason: null,
    violations: Object.freeze(violations),
    errors: Object.freeze([]),
  });
}
