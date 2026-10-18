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

function unquoteGitPath(str) {
  if (!str) return '';
  let s = str.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    s = s.slice(1, -1);
  }
  if (!s.includes('\\')) {
    return s;
  }
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      if (i >= s.length) break;
      const nextChar = s[i];
      if (/[0-7]/.test(nextChar)) {
        let octal = nextChar;
        for (let j = 0; j < 2 && i + 1 < s.length && /[0-7]/.test(s[i + 1]); j++) {
          i++;
          octal += s[i];
        }
        bytes.push(parseInt(octal, 8));
      } else {
        switch (nextChar) {
          case 'a': bytes.push(0x07); break;
          case 'b': bytes.push(0x08); break;
          case 't': bytes.push(0x09); break;
          case 'n': bytes.push(0x0a); break;
          case 'v': bytes.push(0x0b); break;
          case 'f': bytes.push(0x0c); break;
          case 'r': bytes.push(0x0d); break;
          case '"': bytes.push(0x22); break;
          case '\\': bytes.push(0x5c); break;
          default: {
            const charBuf = Buffer.from(nextChar, 'utf8');
            for (const b of charBuf) bytes.push(b);
            break;
          }
        }
      }
    } else {
      const charBuf = Buffer.from(s[i], 'utf8');
      for (const b of charBuf) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function parseDiffGitHeader(line) {
  const rest = line.slice('diff --git '.length).trim();
  if (rest.startsWith('"')) {
    let endA = -1;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '"') {
        let bs = 0;
        for (let j = i - 1; j >= 0 && rest[j] === '\\'; j--) {
          bs++;
        }
        if (bs % 2 === 0) {
          endA = i;
          break;
        }
      }
    }
    if (endA !== -1) {
      const tokenA = rest.slice(0, endA + 1);
      const restAfterA = rest.slice(endA + 1).trim();
      let tokenB = restAfterA;
      if (restAfterA.startsWith('"')) {
        let endB = -1;
        for (let i = 1; i < restAfterA.length; i++) {
          if (restAfterA[i] === '"') {
            let bs = 0;
            for (let j = i - 1; j >= 0 && restAfterA[j] === '\\'; j--) {
              bs++;
            }
            if (bs % 2 === 0) {
              endB = i;
              break;
            }
          }
        }
        if (endB !== -1) {
          tokenB = restAfterA.slice(0, endB + 1);
        }
      }
      const unquotedA = unquoteGitPath(tokenA);
      const unquotedB = unquoteGitPath(tokenB);
      const pathA = unquotedA.startsWith('a/') ? unquotedA.slice(2) : unquotedA;
      const pathB = unquotedB.startsWith('b/') ? unquotedB.slice(2) : unquotedB;
      return { pathA, pathB };
    }
  }

  if (rest.endsWith('"')) {
    let startB = -1;
    for (let i = rest.length - 2; i >= 0; i--) {
      if (rest[i] === '"') {
        let bs = 0;
        for (let j = i - 1; j >= 0 && rest[j] === '\\'; j--) {
          bs++;
        }
        if (bs % 2 === 0 && (i === 0 || /\s/.test(rest[i - 1]))) {
          startB = i;
          break;
        }
      }
    }
    if (startB !== -1) {
      const tokenA = rest.slice(0, startB).trim();
      const tokenB = rest.slice(startB).trim();
      const unquotedA = unquoteGitPath(tokenA);
      const unquotedB = unquoteGitPath(tokenB);
      const pathA = unquotedA.startsWith('a/') ? unquotedA.slice(2) : unquotedA;
      const pathB = unquotedB.startsWith('b/') ? unquotedB.slice(2) : unquotedB;
      return { pathA, pathB };
    }
  }

  const bIndex = rest.indexOf(' b/');
  if (bIndex !== -1 && rest.startsWith('a/')) {
    return {
      pathA: rest.slice(2, bIndex),
      pathB: rest.slice(bIndex + 3),
    };
  }
  const parts = rest.split(' ');
  const rawPathB = parts[1] ? parts[1].replace(/^[b]\//, '') : '';
  const rawPathA = parts[0] ? parts[0].replace(/^[a]\//, '') : '';
  return { pathA: rawPathA, pathB: rawPathB };
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

      const { pathA, pathB } = parseDiffGitHeader(line);

      currentFile = {
        path: pathB || pathA,
        oldPath: pathA || null,
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
      currentFile.oldPath = unquoteGitPath(line.slice('rename from '.length).trim());
      continue;
    }

    if (line.startsWith('rename to ')) {
      currentFile.path = unquoteGitPath(line.slice('rename to '.length).trim());
      continue;
    }

    if (line.startsWith('+++ ')) {
      const rawTarget = line.slice(4).trim();
      if (rawTarget !== '/dev/null') {
        const unquoted = unquoteGitPath(rawTarget);
        const clean = unquoted.startsWith('b/') ? unquoted.slice(2) : unquoted;
        if (clean) {
          currentFile.path = clean;
        }
      }
      continue;
    }

    if (line.startsWith('--- ')) {
      const rawSource = line.slice(4).trim();
      if (rawSource !== '/dev/null') {
        const unquoted = unquoteGitPath(rawSource);
        const clean = unquoted.startsWith('a/') ? unquoted.slice(2) : unquoted;
        if (clean) {
          currentFile.oldPath = clean;
        }
      }
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
    const rawOutput = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], {
      cwd: repositoryRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    if (!rawOutput || rawOutput.length === 0) {
      return Object.freeze([]);
    }
    const files = rawOutput.split('\0').filter((s) => s.length > 0);
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
  const diffArgs = ['-c', 'core.quotepath=false', 'diff', '--no-color'];
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
