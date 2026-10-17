import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

function parseHunkHeader(line) {
  // Matches: @@ -oldStart,oldLen +newStart,newLen @@ or @@ -oldStart +newStart @@
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) {
    return null;
  }
  return {
    oldStart: parseInt(match[1], 10),
    newStart: parseInt(match[2], 10),
  };
}

function finalizeFile(file) {
  if (!file) {
    return null;
  }
  return Object.freeze({
    ...file,
    addedLines: Object.freeze([...file.addedLines]),
    deletedLines: Object.freeze([...file.deletedLines]),
  });
}

/**
 * Parses raw unified diff output into deeply frozen structured file and line changes.
 *
 * @param {string} diffText - Raw git diff output.
 * @returns {ReadonlyArray<object>} Structured changed files.
 */
function parseUnifiedDiff(diffText) {
  if (!diffText || typeof diffText !== 'string' || diffText.trim().length === 0) {
    return Object.freeze([]);
  }

  const files = [];
  const lines = diffText.split(/\r?\n/);
  let currentFile = null;
  let currentOldLine = 0;
  let currentNewLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      if (currentFile) {
        files.push(finalizeFile(currentFile));
      }

      // Format: diff --git a/path b/path
      const parts = line.slice('diff --git '.length).split(' ');
      const rawPathB = parts[1] ? parts[1].replace(/^[b]\//, '') : '';
      const rawPathA = parts[0] ? parts[0].replace(/^[a]\//, '') : '';

      currentFile = {
        path: rawPathB || rawPathA,
        oldPath: null,
        status: 'modified',
        isBinary: false,
        addedLines: [],
        deletedLines: [],
      };
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (line.startsWith('new file mode ')) {
      currentFile.status = 'added';
      continue;
    }

    if (line.startsWith('deleted file mode ')) {
      currentFile.status = 'deleted';
      continue;
    }

    if (line.startsWith('similarity index ')) {
      currentFile.status = 'renamed';
      continue;
    }

    if (line.startsWith('rename from ')) {
      currentFile.status = 'renamed';
      currentFile.oldPath = line.slice('rename from '.length).trim();
      continue;
    }

    if (line.startsWith('rename to ')) {
      currentFile.path = line.slice('rename to '.length).trim();
      continue;
    }

    if ((line.startsWith('Binary files ') && line.endsWith(' differ')) || line.startsWith('GIT binary patch')) {
      currentFile.isBinary = true;
      currentFile.status = 'binary';
      continue;
    }

    if (line.startsWith('@@ ')) {
      const hunk = parseHunkHeader(line);
      if (hunk) {
        currentOldLine = hunk.oldStart;
        currentNewLine = hunk.newStart;
      }
      continue;
    }

    // Process hunk content lines
    if (line.startsWith('+') && !line.startsWith('+++')) {
      currentFile.addedLines.push(
        Object.freeze({
          line: currentNewLine,
          content: line.slice(1),
        })
      );
      currentNewLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      currentFile.deletedLines.push(
        Object.freeze({
          line: currentOldLine,
          content: line.slice(1),
        })
      );
      currentOldLine++;
    } else if (line.startsWith(' ')) {
      currentOldLine++;
      currentNewLine++;
    }
  }

  if (currentFile) {
    files.push(finalizeFile(currentFile));
  }

  return Object.freeze(files);
}

function getUntrackedFiles(repositoryRoot) {
  try {
    const rawOutput = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: repositoryRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    if (!rawOutput || rawOutput.trim().length === 0) {
      return Object.freeze([]);
    }
    const files = rawOutput.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return Object.freeze(files);
  } catch {
    return Object.freeze([]);
  }
}

function readUntrackedFile(repositoryRoot, relativePath) {
  const fullPath = path.resolve(repositoryRoot, relativePath);
  try {
    const buffer = fs.readFileSync(fullPath);
    // Check for null bytes to detect binary files
    const isBinary = buffer.includes(0);
    if (isBinary) {
      return Object.freeze({
        path: relativePath,
        oldPath: null,
        status: 'binary',
        isBinary: true,
        addedLines: Object.freeze([]),
        deletedLines: Object.freeze([]),
      });
    }

    const text = buffer.toString('utf8');
    const rawLines = text.split(/\r?\n/);
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
      rawLines.pop();
    }
    const addedLines = rawLines.map((content, idx) =>
      Object.freeze({
        line: idx + 1,
        content,
      })
    );

    return Object.freeze({
      path: relativePath,
      oldPath: null,
      status: 'untracked',
      isBinary: false,
      addedLines: Object.freeze(addedLines),
      deletedLines: Object.freeze([]),
    });
  } catch {
    return null;
  }
}

/**
 * Reads and parses Git diff per Section 5 of BLOAT_CHECKER_V1_BUILD_SPEC.md.
 * Fails closed if repository is invalid or base revision cannot be resolved.
 * Deliberately handles untracked files, renames, deletions, and binary files.
 *
 * @param {object} [options]
 * @param {string} [options.repositoryRoot] - Repository directory (defaults to process.cwd()).
 * @param {string} [options.base] - Git base commit, tag, or branch (e.g. 'HEAD', 'main').
 * @param {boolean} [options.staged] - If true, reads staged changes (--cached).
 * @param {boolean} [options.includeUntracked] - If true, parses untracked files into changedFiles.
 * @returns {{
 *   success: boolean,
 *   diffText: string,
 *   base: string | null,
 *   changedFiles: ReadonlyArray<object>,
 *   untrackedFiles: ReadonlyArray<string>,
 *   warnings: ReadonlyArray<string>,
 *   errors: ReadonlyArray<string>
 * }}
 */
export function readGitDiff(options = {}) {
  const repositoryRoot = options.repositoryRoot ? path.resolve(options.repositoryRoot) : process.cwd();
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(repositoryRoot)) {
    return Object.freeze({
      success: false,
      diffText: '',
      base: null,
      changedFiles: Object.freeze([]),
      untrackedFiles: Object.freeze([]),
      warnings: Object.freeze([]),
      errors: Object.freeze([`Repository root does not exist: ${repositoryRoot}`]),
    });
  }

  // 1. Verify directory is inside a Git repository
  try {
    const isGit = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repositoryRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();

    if (isGit !== 'true') {
      errors.push(`Directory is not inside a git work tree: ${repositoryRoot}`);
    }
  } catch (err) {
    errors.push(`Git repository check failed for ${repositoryRoot}: ${err.message}`);
  }

  if (errors.length > 0) {
    return Object.freeze({
      success: false,
      diffText: '',
      base: null,
      changedFiles: Object.freeze([]),
      untrackedFiles: Object.freeze([]),
      warnings: Object.freeze([]),
      errors: Object.freeze(errors),
    });
  }

  // 2. Validate base revision if specified
  let resolvedBase = options.base ? String(options.base).trim() : null;
  if (resolvedBase) {
    try {
      execFileSync('git', ['rev-parse', '--verify', resolvedBase], {
        cwd: repositoryRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
    } catch (err) {
      errors.push(`Cannot resolve base revision '${resolvedBase}': ${err.message}`);
      return Object.freeze({
        success: false,
        diffText: '',
        base: resolvedBase,
        changedFiles: Object.freeze([]),
        untrackedFiles: Object.freeze([]),
        warnings: Object.freeze([]),
        errors: Object.freeze(errors),
      });
    }
  }

  // 3. Assemble and execute diff command
  const diffArgs = ['diff', '--no-color'];
  if (options.staged) {
    diffArgs.push('--cached');
  }
  if (resolvedBase) {
    diffArgs.push(resolvedBase);
  }

  let rawDiff = '';
  try {
    rawDiff = execFileSync('git', diffArgs, {
      cwd: repositoryRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (err) {
    errors.push(`Failed to read git diff: ${err.message}`);
    return Object.freeze({
      success: false,
      diffText: '',
      base: resolvedBase,
      changedFiles: Object.freeze([]),
      untrackedFiles: Object.freeze([]),
      warnings: Object.freeze([]),
      errors: Object.freeze(errors),
    });
  }

  const changedFiles = [...parseUnifiedDiff(rawDiff)];
  const untrackedFiles = getUntrackedFiles(repositoryRoot);

  // 4. Deliberately handle untracked files per Section 5
  if (untrackedFiles.length > 0) {
    if (options.includeUntracked) {
      for (const relPath of untrackedFiles) {
        const fileObj = readUntrackedFile(repositoryRoot, relPath);
        if (fileObj) {
          changedFiles.push(fileObj);
        }
      }
    } else {
      warnings.push(
        `Detected ${untrackedFiles.length} untracked file(s) omitted from diff review: ${untrackedFiles.join(', ')}. Pass includeUntracked: true or stage files to review them.`
      );
    }
  }

  if (changedFiles.length === 0) {
    warnings.push('No file modifications found in the evaluated diff range.');
  }

  return Object.freeze({
    success: true,
    diffText: rawDiff,
    base: resolvedBase,
    changedFiles: Object.freeze(changedFiles),
    untrackedFiles,
    warnings: Object.freeze(warnings),
    errors: Object.freeze([]),
  });
}
