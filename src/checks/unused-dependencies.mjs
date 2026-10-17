import fs from 'node:fs';
import path from 'node:path';

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

function extractAddedProductionDependencies(packageJsonDiffFile, repositoryRoot) {
  if (!packageJsonDiffFile || !Array.isArray(packageJsonDiffFile.addedLines)) {
    return [];
  }

  // Read current package.json to strictly scope to production 'dependencies'
  let currentDependencies = {};
  try {
    const fullPkgPath = path.resolve(repositoryRoot, packageJsonDiffFile.path);
    if (fs.existsSync(fullPkgPath)) {
      const parsedPkg = JSON.parse(fs.readFileSync(fullPkgPath, 'utf8'));
      if (parsedPkg && typeof parsedPkg.dependencies === 'object' && parsedPkg.dependencies !== null) {
        currentDependencies = parsedPkg.dependencies;
      }
    }
  } catch {
    // If package.json cannot be read/parsed, fall back to empty
    return [];
  }

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

  return addedDeps;
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

function isPackageReferenced(packageName, sourceFiles, packageJsonPath) {
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

  const resolvedPkgPath = path.resolve(packageJsonPath);

  for (const filePath of sourceFiles) {
    // Exclude the package.json itself from the reference search
    if (path.resolve(filePath) === resolvedPkgPath) {
      continue;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (referenceRegex.test(content)) {
        return {
          referenced: true,
          referencedIn: filePath,
        };
      }
    } catch {
      // Skip unreadable files
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

  const addedDeps = extractAddedProductionDependencies(packageJsonFile, repositoryRoot);
  if (addedDeps.length === 0) {
    return Object.freeze({
      executed: true,
      skippedReason: null,
      violations: Object.freeze([]),
      errors: Object.freeze([]),
    });
  }

  const fullPkgJsonPath = path.resolve(repositoryRoot, packageJsonFile.path);
  const sourceFiles = findSourceFiles(repositoryRoot);
  const violations = [];

  for (const dep of addedDeps) {
    const usage = isPackageReferenced(dep.packageName, sourceFiles, fullPkgJsonPath);
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
