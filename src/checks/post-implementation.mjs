import fs from 'node:fs';
import path from 'node:path';
import { SEVERITIES, FINDING_STATUSES } from '../severities.mjs';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
  'is', 'it', 'be', 'as', 'from', 'this', 'that', 'add', 'implement', 'update', 'fix',
  'change', 'create', 'make', 'support', 'ensure', 'modify', 'new', 'code', 'function',
  'method', 'file', 'feature', 'request', 'should', 'must', 'will', 'can', 'into',
  'than', 'then', 'only', 'all', 'any', 'not', 'but', 'both', 'each', 'such', 'please',
]);

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
]);

const TEST_FILE_REGEX = /(?:^|[\\/])(?:test|tests|__tests__|spec)[\\/]|[.](?:test|spec)[.][a-zA-Z0-9]+$/i;

function isTestFilePath(filePath) {
  return TEST_FILE_REGEX.test(filePath);
}

const CODE_FILE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx',
]);

function isSourceCodeFile(filePath) {
  if (typeof filePath !== 'string') return false;
  const ext = path.extname(filePath).toLowerCase();
  return CODE_FILE_EXTENSIONS.has(ext);
}

function checkImplementationSubstance(changedFiles) {
  let sourceFilesCount = 0;
  let totalExecutableLines = 0;
  let realLogicStatementsCount = 0;

  for (const file of changedFiles) {
    if (file.isBinary || file.status === 'D') continue;
    if (isTestFilePath(file.path)) continue;

    if (isSourceCodeFile(file.path)) {
      sourceFilesCount++;
    }

    const addedLines = Array.isArray(file.addedLines) ? file.addedLines : [];
    for (const item of addedLines) {
      const line = item.content.trim();
      if (!line) continue;
      if (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*') || line.startsWith('*/')) {
        continue;
      }
      if (line.startsWith('import ') || /^export\s+(?:\*|\{[^}]*\})\s+from\b/.test(line)) {
        continue;
      }

      totalExecutableLines++;

      const isSignatureOrDeclaration =
        /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function(?:\s+[a-zA-Z0-9_$]+)?\s*\([^)]*\)\s*\{?$/.test(line) ||
        /^(?:export\s+)?(?:const|let|var)\s+[a-zA-Z0-9_$]+\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>\s*\{?$/.test(line) ||
        /^(?:export\s+)?(?:abstract\s+)?class\s+[a-zA-Z0-9_$]+(?:\s+extends\s+[a-zA-Z0-9_$]+)?\s*\{?$/.test(line);

      const isStub =
        /^(?:return\s*(?:null|undefined|false|true|\[\]|\{\}|""|''|;)?\s*;?|throw\s+new\s+Error\s*\(\s*['"](?:not implemented|todo)[^'"]*['"]\s*\);?)$/i.test(line) ||
        /^(?:(?:async\s+)?function\s+[a-zA-Z0-9_$]+\s*\([^)]*\)|\([^)]*\)\s*=>|[a-zA-Z0-9_$]+\s*=>)\s*\{\s*\}$/.test(line);

      const isStructuralBrace =
        /^(?:\{|\}|\{|\}|(?:\}\s*else\s*\{)|(?:\}\s*catch\b.*\{)|(?:\}\s*finally\s*\{))$/.test(line) ||
        line === '};' || line === '});' || line === '];' || line === ');';

      if (!isStub && !isStructuralBrace && !isSignatureOrDeclaration) {
        realLogicStatementsCount++;
      }
    }
  }

  return {
    sourceFilesCount,
    totalExecutableLines,
    realLogicStatementsCount,
    isSemanticallyEmpty: sourceFilesCount === 0 || totalExecutableLines === 0 || realLogicStatementsCount === 0,
  };
}

function stemWord(word) {
  if (typeof word !== 'string') return '';
  const w = word.toLowerCase();
  if (w.endsWith('ies') && w.length > 4) {
    return w.slice(0, -3) + 'y';
  }
  if (w.endsWith('es') && w.length > 3) {
    return w.slice(0, -2);
  }
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 2) {
    return w.slice(0, -1);
  }
  if (w.endsWith('ing') && w.length > 4) {
    return w.slice(0, -3);
  }
  if (w.endsWith('ed') && w.length > 3) {
    return w.slice(0, -2);
  }
  return w;
}

function extractDomainTokens(goalText) {
  if (typeof goalText !== 'string') return [];
  const rawWords = goalText.toLowerCase().replace(/[^a-z0-9_-]/g, ' ').split(/\s+/);
  const filtered = rawWords.filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  const tokens = new Set();
  for (const w of filtered) {
    tokens.add(w);
    const stem = stemWord(w);
    if (stem.length >= 3) {
      tokens.add(stem);
    }
  }
  return Array.from(tokens);
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
        if (['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx'].includes(ext)) {
          fileList.push(path.join(dir, entry.name));
        }
      }
    }
  } catch {
    // Gracefully handle unreadable directories
  }
  return fileList;
}

function isIdentifierUsedElsewhere(identifier, repositoryRoot, originatingFile) {
  const sourceFiles = findSourceFiles(repositoryRoot);
  const regex = new RegExp(`\\b${identifier}\\b`);

  for (const file of sourceFiles) {
    if (file === originatingFile) continue;
    try {
      const content = fs.readFileSync(file, 'utf8');
      if (regex.test(content)) {
        return true;
      }
    } catch {
      // skip unreadable
    }
  }
  return false;
}

/**
 * Executes post-implementation code quality inspection and goal verification.
 *
 * @param {object} context
 * @param {string} context.repositoryRoot - Root directory of target repository.
 * @param {object} context.diffResult - Structured Git or direct diff result.
 * @param {ReadonlyArray<object>} [context.rules] - Active rule set.
 * @param {string} [context.goal] - Original feature request or goal text.
 * @returns {object} Standard check execution result.
 */
export function checkPostImplementation(context = {}) {
  const { repositoryRoot = process.cwd(), diffResult, goal } = context;
  const violations = [];
  const errors = [];
  const warnings = [];
  const limitations = [];

  if (!diffResult || typeof diffResult !== 'object' || !diffResult.success) {
    return Object.freeze({
      executed: false,
      skippedReason: 'Diff result was missing, invalid, or unsuccessful.',
      violations: Object.freeze([]),
      errors: Object.freeze(['Diff inspection must succeed before post-implementation checks can run.']),
      warnings: Object.freeze([]),
      limitations: Object.freeze([]),
    });
  }

  const changedFiles = Array.isArray(diffResult.changedFiles) ? diffResult.changedFiles : [];
  const trimmedGoal = typeof goal === 'string' ? goal.trim() : '';

  // 1. Goal Context Check
  if (!trimmedGoal) {
    limitations.push('Original implementation goal was not provided. Evaluating changes without goal-alignment verification.');
  }

  // 2. Goal Alignment Evaluation
  if (trimmedGoal) {
    if (changedFiles.length === 0) {
      violations.push(
        Object.freeze({
          ruleId: 'RULE-GOAL-ALIGNMENT',
          filePath: 'package.json',
          line: 1,
          status: FINDING_STATUSES.VERIFIED,
          severity: SEVERITIES.CRITICAL,
          evidence: `Goal: "${trimmedGoal}" (0 files changed in reviewed diff)`,
          category: 'goal-alignment',
          title: 'Goal unfulfilled: zero code modifications implemented',
          details: `The requested goal "${trimmedGoal}" was not implemented; the reviewed diff contains zero file modifications.`,
          impact: 'A completed implementation was expected, but no modifications were made to the codebase.',
          nextAction: 'Implement the code changes necessary to fulfill the requested goal.',
          confidence: 'high',
        })
      );
    } else {
      const substance = checkImplementationSubstance(changedFiles);

      if (substance.isSemanticallyEmpty) {
        const primaryFile = changedFiles.find((f) => !isTestFilePath(f.path))?.path || changedFiles[0]?.path || 'package.json';
        violations.push(
          Object.freeze({
            ruleId: 'RULE-GOAL-ALIGNMENT',
            filePath: primaryFile,
            line: 1,
            status: FINDING_STATUSES.VERIFIED,
            severity: SEVERITIES.CRITICAL,
            evidence: `Goal: "${trimmedGoal}" (implementation is demonstrably empty or contains only stubs/placeholders)`,
            category: 'goal-alignment',
            title: 'Goal unfulfilled: demonstrably empty or stubbed implementation',
            details: `The reviewed changes contain zero functional business logic for "${trimmedGoal}"; added content consists exclusively of empty stubs, comments, or non-code files.`,
            impact: 'The requested functionality was not implemented; placeholder stubs cannot satisfy production requirements.',
            nextAction: 'Implement the functional logic required to fulfill the goal.',
            confidence: 'high',
          })
        );
      } else {
        const domainTokens = extractDomainTokens(trimmedGoal);
        const ignoredDomainTokens = new Set(['null', 'undefined', 'true', 'false', 'diff', 'git', 'index', 'dev']);
        const effectiveDomainTokens = domainTokens.filter((t) => !ignoredDomainTokens.has(t));

        if (effectiveDomainTokens.length >= 2) {
          let matchedTokens = 0;
          const codeText = changedFiles
            .map((f) => (f.addedLines || []).map((l) => l.content).join(' '))
            .join(' ')
            .toLowerCase();
          const allPaths = changedFiles.map((f) => f.path.toLowerCase()).join(' ');

          for (const token of effectiveDomainTokens) {
            if (codeText.includes(token) || allPaths.includes(token)) {
              matchedTokens++;
            }
          }

          // If zero domain tokens appear anywhere in changed paths or diff text
          if (matchedTokens === 0) {
            const primaryFile = changedFiles.find((f) => !isTestFilePath(f.path))?.path || changedFiles[0]?.path || 'package.json';
            violations.push(
              Object.freeze({
                ruleId: 'RULE-GOAL-ALIGNMENT',
                filePath: primaryFile,
                line: 1,
                status: FINDING_STATUSES.UNVERIFIED,
                severity: SEVERITIES.MINOR,
                evidence: `Goal: "${trimmedGoal}" (0 matching domain keywords in diff)`,
                category: 'goal-alignment',
                title: 'Goal alignment unverified: insufficient evidence connecting changes to goal',
                details: `Reviewed changes implement functional code, but domain concepts from the goal "${trimmedGoal}" were not directly matched in reviewed identifiers or paths.`,
                impact: 'Static analysis cannot conclusively confirm goal fulfillment without concept matching or test execution.',
                nextAction: 'Verify via automated tests or code inspection that the implementation addresses the intended goal.',
                confidence: 'low',
              })
            );
          }
        }
      }
    }
  }

  // 3. Static Quality Inspections Across Changed Files
  let totalNonTestAddedLines = 0;
  let testFilesModifiedCount = 0;
  let primaryNonTestSourceFile = null;

  for (const file of changedFiles) {
    if (file.isBinary || file.status === 'D') {
      continue;
    }

    const relPath = file.path;
    const isTest = isTestFilePath(relPath);
    const addedLines = Array.isArray(file.addedLines) ? file.addedLines : [];

    if (isTest) {
      testFilesModifiedCount++;
    } else {
      totalNonTestAddedLines += addedLines.length;
      if (!primaryNonTestSourceFile && addedLines.length > 0) {
        primaryNonTestSourceFile = file;
      }
    }

    // Read full file content if available on disk for reference checking
    const fullDiskPath = path.resolve(repositoryRoot, relPath);
    let fullFileContent = '';
    let hasDiskFile = false;
    try {
      if (fs.existsSync(fullDiskPath)) {
        fullFileContent = fs.readFileSync(fullDiskPath, 'utf8');
        hasDiskFile = true;
      }
    } catch {
      // Ignore read errors
    }

    // Combine added lines for analysis if file is not on disk (e.g. in-memory diff)
    const fileContentToAnalyze = hasDiskFile
      ? fullFileContent
      : addedLines.map((l) => l.content).join('\n');

    // A. Unused Imports in Added Lines
    for (let idx = 0; idx < addedLines.length; idx++) {
      const item = addedLines[idx];
      const lineContent = item.content.trim();

      // Matches: import { foo, bar as baz } from '...'
      const namedMatch = lineContent.match(/^import\s+\{([^}]+)\}\s+from\s+['"][^'"]+['"]/);
      if (namedMatch) {
        const identifiers = namedMatch[1]
          .split(',')
          .map((id) => {
            const parts = id.trim().split(/\s+as\s+/);
            return parts[parts.length - 1].trim();
          })
          .filter((id) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(id));

        for (const id of identifiers) {
          const idRegex = new RegExp(`\\b${id}\\b`, 'g');
          const occurrences = (fileContentToAnalyze.match(idRegex) || []).length;
          // If only 1 occurrence in file (the import declaration itself)
          if (occurrences <= 1) {
            const isReExported = new RegExp(`export\\s*\\{[^}]*\\b${id}\\b`).test(fileContentToAnalyze);
            if (!isReExported) {
              violations.push(
                Object.freeze({
                  ruleId: 'RULE-NO-UNUSED-LOCALS',
                  filePath: relPath,
                  line: item.line,
                  status: FINDING_STATUSES.VERIFIED,
                  severity: SEVERITIES.MAJOR,
                  evidence: item.content.trim(),
                  category: 'dead-code',
                  title: `Unused import '${id}'`,
                  details: `The imported identifier '${id}' is declared on line ${item.line} but never referenced in ${relPath}.`,
                  impact: 'Unused imports introduce cognitive overhead and can unnecessarily pull unneeded code into bundle graphs.',
                  nextAction: `Remove '${id}' from the import declaration in ${relPath}.`,
                  confidence: 'high',
                })
              );
            }
          }
        }
      }

      // Matches: import defaultExport from '...'
      const defaultMatch = lineContent.match(/^import\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s+from\s+['"][^'"]+['"]/);
      if (defaultMatch) {
        const id = defaultMatch[1];
        const idRegex = new RegExp(`\\b${id}\\b`, 'g');
        const occurrences = (fileContentToAnalyze.match(idRegex) || []).length;
        if (occurrences <= 1) {
          const isReExported = new RegExp(`export\\s+(?:default\\s+)?\\b${id}\\b`).test(fileContentToAnalyze);
          if (!isReExported) {
            violations.push(
              Object.freeze({
                ruleId: 'RULE-NO-UNUSED-LOCALS',
                filePath: relPath,
                line: item.line,
                status: FINDING_STATUSES.VERIFIED,
                severity: SEVERITIES.MAJOR,
                evidence: item.content.trim(),
                category: 'dead-code',
                title: `Unused default import '${id}'`,
                details: `Default import '${id}' is imported on line ${item.line} but has zero usages in ${relPath}.`,
                impact: 'Unused imports clutter module headers and obscure real file dependencies.',
                nextAction: `Remove the unused import statement on line ${item.line}.`,
                confidence: 'high',
              })
            );
          }
        }
      }

      // B. Silent Exception Swallowing (Empty Catch Blocks)
      if (
        /catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(lineContent) ||
        /catch\s*(?:\([^)]*\))?\s*\{\s*\/\/[^\n]*\}/.test(lineContent)
      ) {
        violations.push(
          Object.freeze({
            ruleId: 'RULE-NO-SILENT-FAILURES',
            filePath: relPath,
            line: item.line,
            status: FINDING_STATUSES.VERIFIED,
            severity: SEVERITIES.MAJOR,
            evidence: item.content.trim(),
            category: 'code-smell',
            title: 'Silent exception swallowing in empty catch block',
            details: `An empty catch block was introduced on line ${item.line} in ${relPath} without logging, handling, or rethrowing.`,
            impact: 'Swallowing errors without handling or logging conceals runtime failures and turns bugs into untraceable silent failures.',
            nextAction: 'Handle the error, log diagnostic details, or rethrow the exception.',
            confidence: 'high',
          })
        );
      }

      // C. Fragile Workarounds & Hardcoded Bypasses
      if (
        /\/\/\s*(?:TODO|FIXME)\s*:\s*(?:hack|bypass|workaround|temporary)/i.test(lineContent) ||
        /(?:const|let|var)\s+(?:bypassAuth|mockMode|disableSecurity|fakeSuccess)\s*=\s*true\b/i.test(lineContent)
      ) {
        if (!isTest) {
          violations.push(
            Object.freeze({
              ruleId: 'RULE-NO-SPECULATIVE-ABSTRACTIONS',
              filePath: relPath,
              line: item.line,
              status: FINDING_STATUSES.VERIFIED,
              severity: SEVERITIES.MAJOR,
              evidence: item.content.trim(),
              category: 'code-smell',
              title: 'Hardcoded bypass or fragile workaround detected',
              details: `Line ${item.line} in ${relPath} introduces an explicit bypass flag or acknowledged workaround.`,
              impact: 'Hardcoded bypasses and fragile workarounds introduce regressions and security vulnerabilities in production paths.',
              nextAction: 'Replace temporary workaround with proper conditional logic or error handling.',
              confidence: 'high',
            })
          );
        }
      }

      // D. Redundant / Excessive Defensive Conditions
      if (
        /typeof\s+([a-zA-Z0-9_$]+)\s*===\s*['"]undefined['"]\s*\|\|\s*\1\s*===\s*null\s*\|\|\s*!\1/.test(lineContent) ||
        /!([a-zA-Z0-9_$]+)\s*\|\|\s*\1\s*===\s*null\s*\|\|\s*\1\s*===\s*undefined/.test(lineContent)
      ) {
        violations.push(
          Object.freeze({
            ruleId: 'RULE-NO-SPECULATIVE-ABSTRACTIONS',
            filePath: relPath,
            line: item.line,
            status: FINDING_STATUSES.VERIFIED,
            severity: SEVERITIES.MINOR,
            evidence: item.content.trim(),
            category: 'unnecessary-complexity',
            title: 'Redundant defensive checks in conditional expression',
            details: `Line ${item.line} in ${relPath} performs multiple redundant null/undefined/falsy checks on the same variable.`,
            impact: 'Excessive defensive checks obscure control flow and add noisy boilerplate without increasing safety.',
            nextAction: 'Simplify to a single truthiness or nullish check (e.g. `!value` or `value == null`).',
            confidence: 'high',
          })
        );
      }

      // E. Unnecessary Delegating Wrappers (Advisory)
      const arrowWrapperMatch = lineContent.match(
        /^(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:\(([^)]*)\)|([a-zA-Z0-9_$]+))\s*=>\s*([a-zA-Z0-9_$]+(?:\.[a-zA-Z0-9_$]+)?)\s*\(([^)]*)\);?$/
      );
      if (arrowWrapperMatch && !isTest) {
        const wrapperName = arrowWrapperMatch[1];
        const params = (arrowWrapperMatch[2] || arrowWrapperMatch[3] || '').trim();
        const targetName = arrowWrapperMatch[4];
        const targetArgs = arrowWrapperMatch[5].trim();

        if (wrapperName !== targetName && (params === targetArgs || (!params && !targetArgs))) {
          violations.push(
            Object.freeze({
              ruleId: 'RULE-NO-SPECULATIVE-ABSTRACTIONS',
              filePath: relPath,
              line: item.line,
              status: FINDING_STATUSES.UNVERIFIED,
              severity: SEVERITIES.MINOR,
              evidence: item.content.trim(),
              category: 'unnecessary-complexity',
              title: `Unnecessary delegating wrapper '${wrapperName}'`,
              details: `Function '${wrapperName}' on line ${item.line} is a direct pass-through delegating wrapper around '${targetName}' without adding logic, transformation, or validation.`,
              impact: 'Thin delegating wrappers add indirection and cognitive overhead without providing abstraction value.',
              nextAction: `Call '${targetName}' directly or inline the delegating wrapper.`,
              confidence: 'medium',
            })
          );
        }
      }

      const fnDeclMatch = lineContent.match(
        /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(([^)]*)\)\s*\{?$/
      );
      if (fnDeclMatch && !isTest) {
        const wrapperName = fnDeclMatch[1];
        const params = fnDeclMatch[2].trim();
        let returnLineIdx = -1;
        for (let j = idx + 1; j < Math.min(addedLines.length, idx + 5); j++) {
          const nextTrim = addedLines[j].content.trim();
          if (!nextTrim || nextTrim.startsWith('//') || nextTrim.startsWith('/*')) continue;
          if (returnLineIdx === -1) {
            returnLineIdx = j;
          } else {
            if (nextTrim === '}') {
              const retMatch = addedLines[returnLineIdx].content.trim().match(
                /^return\s+([a-zA-Z0-9_$]+(?:\.[a-zA-Z0-9_$]+)?)\s*\(([^)]*)\);?$/
              );
              if (retMatch) {
                const targetName = retMatch[1];
                const targetArgs = retMatch[2].trim();
                if (wrapperName !== targetName && (params === targetArgs || (!params && !targetArgs))) {
                  violations.push(
                    Object.freeze({
                      ruleId: 'RULE-NO-SPECULATIVE-ABSTRACTIONS',
                      filePath: relPath,
                      line: item.line,
                      status: FINDING_STATUSES.UNVERIFIED,
                      severity: SEVERITIES.MINOR,
                      evidence: item.content.trim(),
                      category: 'unnecessary-complexity',
                      title: `Unnecessary delegating wrapper '${wrapperName}'`,
                      details: `Function '${wrapperName}' on line ${item.line} is a direct pass-through delegating wrapper around '${targetName}' without adding logic, transformation, or validation.`,
                      impact: 'Thin delegating wrappers add indirection and cognitive overhead without providing abstraction value.',
                      nextAction: `Call '${targetName}' directly or inline the delegating wrapper.`,
                      confidence: 'medium',
                    })
                  );
                }
              }
            }
            break;
          }
        }
      }

      // F. Dead Private Helper Functions
      const fnMatch = lineContent.match(/^(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>/) ||
        lineContent.match(/^(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(/);
      if (fnMatch && !isTest && !lineContent.startsWith('export')) {
        const fnName = fnMatch[1];
        // Ensure not exported later
        const isExported = new RegExp(`export\\s*\\{[^}]*\\b${fnName}\\b`).test(fileContentToAnalyze);
        if (!isExported) {
          const fnRegex = new RegExp(`\\b${fnName}\\b`, 'g');
          const occurrences = (fileContentToAnalyze.match(fnRegex) || []).length;
          if (occurrences <= 1) {
            violations.push(
              Object.freeze({
                ruleId: 'RULE-NO-UNUSED-LOCALS',
                filePath: relPath,
                line: item.line,
                status: FINDING_STATUSES.VERIFIED,
                severity: SEVERITIES.MAJOR,
                evidence: item.content.trim(),
                category: 'dead-code',
                title: `Unreferenced private helper '${fnName}'`,
                details: `Function '${fnName}' is declared on line ${item.line} but has zero invocations in ${relPath} and is not exported.`,
                impact: 'Uncalled dead functions clutter the codebase and suggest incomplete implementation.',
                nextAction: `Remove unreferenced helper '${fnName}' or connect it to active code paths.`,
                confidence: 'high',
              })
            );
          }
        }
      }
    }
  }

  // 4. Duplicated Logic Check (Advisory)
  const seenLogicBlocks = new Map();
  for (const file of changedFiles) {
    if (file.isBinary || file.status === 'D' || isTestFilePath(file.path)) {
      continue;
    }
    const addedLines = Array.isArray(file.addedLines) ? file.addedLines : [];
    const nonTrivialItems = [];
    for (const item of addedLines) {
      const s = item.content.trim();
      if (
        s.length >= 10 &&
        !s.startsWith('//') &&
        !s.startsWith('/*') &&
        !s.startsWith('*') &&
        !s.startsWith('import ') &&
        !s.startsWith('export ') &&
        !/^(?:\{|\}|\{|\}|(?:\}\s*else\s*\{)|(?:\}\s*catch\b.*\{))$/.test(s) &&
        s !== '};' &&
        s !== '});' &&
        s !== ']);' &&
        s !== 'return;'
      ) {
        nonTrivialItems.push(item);
      }
    }

    for (let i = 0; i <= nonTrivialItems.length - 3; i++) {
      const blockItems = [nonTrivialItems[i], nonTrivialItems[i + 1], nonTrivialItems[i + 2]];
      if (blockItems[2].line - blockItems[0].line <= 5) {
        const key = blockItems.map((b) => b.content.trim().replace(/\s+/g, ' ')).join('\n');
        if (seenLogicBlocks.has(key)) {
          const prev = seenLogicBlocks.get(key);
          if (!prev.reported) {
            prev.reported = true;
            violations.push(
              Object.freeze({
                ruleId: 'RULE-NO-SPECULATIVE-ABSTRACTIONS',
                filePath: file.path,
                line: blockItems[0].line,
                status: FINDING_STATUSES.UNVERIFIED,
                severity: SEVERITIES.MINOR,
                evidence: blockItems.map((b) => b.content.trim()).join('\n'),
                category: 'unnecessary-complexity',
                title: `Duplicated logic block detected in '${file.path}'`,
                details: `A block of consecutive identical logic lines was duplicated at line ${blockItems[0].line} (previously seen in ${prev.filePath}:${prev.line}). Consider consolidating into a shared helper function.`,
                impact: 'Duplicated logic increases maintenance overhead and creates risks of divergent bug fixes.',
                nextAction: 'Consolidate the duplicated logic block into a shared reusable helper.',
                confidence: 'medium',
              })
            );
          }
        } else {
          seenLogicBlocks.set(key, {
            filePath: file.path,
            line: blockItems[0].line,
            reported: false,
          });
        }
      }
    }
  }

  // 5. Test Adequacy Check (Advisory)
  // If significant logic added (>25 lines in non-test files) but 0 test files modified
  if (totalNonTestAddedLines >= 25 && testFilesModifiedCount === 0 && primaryNonTestSourceFile) {
    // Check if the repo has an existing test suite
    const testDir = path.resolve(repositoryRoot, 'test');
    if (fs.existsSync(testDir)) {
      violations.push(
        Object.freeze({
          ruleId: 'RULE-TEST-ADEQUACY',
          filePath: primaryNonTestSourceFile.path,
          line: primaryNonTestSourceFile.addedLines[0]?.line || 1,
          status: FINDING_STATUSES.UNVERIFIED,
          severity: SEVERITIES.MINOR,
          evidence: `Modified ${primaryNonTestSourceFile.path} (+${totalNonTestAddedLines} non-test lines across changes; 0 test updates)`,
          category: 'test-coverage',
          title: 'Implementation changes lack accompanying automated tests',
          details: `Substantial business logic (+${totalNonTestAddedLines} lines) was added across non-test files, but no test files were updated or added.`,
          impact: 'Unverified changes carry regression risks that automated CI cannot catch.',
          nextAction: 'Add automated tests in the test suite to verify the new behavior.',
          confidence: 'heuristic',
        })
      );
    }
  }

  return Object.freeze({
    executed: true,
    skippedReason: null,
    violations: Object.freeze(violations),
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
    limitations: Object.freeze(limitations),
  });
}
