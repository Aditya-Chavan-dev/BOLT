import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXIT_CODES } from './constants.mjs';
import { FINDING_STATUSES } from './severities.mjs';
import { loadRules } from './rule-loader.mjs';
import { readGitDiff } from './git-diff.mjs';
import { checkUnusedDependencies } from './checks/unused-dependencies.mjs';
import { generateFinding } from './finding-generator.mjs';
import { validateFinding } from './finding-schema.mjs';
import { validateFindingEvidence } from './finding-validator.mjs';
import { formatHumanReport, formatJsonReport } from './report-formatter.mjs';

export { formatHumanReport, formatJsonReport };

export const MANDATORY_CHECKS = Object.freeze([
  Object.freeze({
    name: 'unused-dependencies',
    fn: checkUnusedDependencies,
  }),
]);

/**
 * Evaluates the authoritative gate policy and derives the numerical exit code.
 *
 * Policy:
 * 1. Setup / configuration errors (invalid repo, missing base, invalid SSOT) -> EXIT_CODES.SETUP_ERROR (3).
 * 2. Incomplete or failed verification:
 *    - Any required check that failed to execute due to error
 *    - Any finding with status === 'verification-incomplete'
 *    -> FAIL CLOSED with EXIT_CODES.VERIFICATION_FAILURE (2).
 * 3. One or more verified blocking violations (blocksWorkflow === true) -> EXIT_CODES.POLICY_FAILURE (1).
 * 4. Clean scan (all checks completed, zero blocking violations) -> EXIT_CODES.SUCCESS (0).
 *
 * @param {object} params
 * @param {boolean} params.setupError - Whether a setup/configuration error occurred.
 * @param {boolean} params.verificationIncomplete - Whether any mandatory verification failed or was incomplete.
 * @param {ReadonlyArray<object>} params.findings - Generated finding objects.
 * @returns {{ exitCode: number, decision: 'pass' | 'blocked' | 'incomplete' | 'error', summary: string }}
 */
function evaluateGatePolicy({ setupError, verificationIncomplete, findings }) {
  if (setupError) {
    return {
      exitCode: EXIT_CODES.SETUP_ERROR,
      decision: 'error',
      summary: 'Gate failed due to setup or configuration error.',
    };
  }

  if (verificationIncomplete) {
    return {
      exitCode: EXIT_CODES.VERIFICATION_FAILURE,
      decision: 'incomplete',
      summary: 'Gate failed closed: required verification could not complete or is incomplete.',
    };
  }

  const blockingFindings = findings.filter((f) => f.blocksWorkflow === true);
  if (blockingFindings.length > 0) {
    return {
      exitCode: EXIT_CODES.POLICY_FAILURE,
      decision: 'blocked',
      summary: `Gate blocked: ${blockingFindings.length} verified blocking violation(s) detected.`,
    };
  }

  return {
    exitCode: EXIT_CODES.SUCCESS,
    decision: 'pass',
    summary: 'Gate passed: all checks completed cleanly with zero blocking violations.',
  };
}

function isEscapingRelative(rel) {
  if (path.isAbsolute(rel)) return true;
  return rel === '..' || rel.startsWith(`..${path.sep}`) || rel.startsWith('../') || rel.startsWith('..\\');
}

/**
 * Runs the end-to-end Bloat Checker gate evaluation pipeline per Sections 9, 10, and 11.
 *
 * @param {object} [options]
 * @param {string} [options.repositoryRoot] - Target repository root path.
 * @param {string} [options.base] - Base git revision to diff against (e.g. 'HEAD~1', 'origin/main').
 * @param {boolean} [options.staged] - Whether to diff staged index changes against HEAD.
 * @param {boolean} [options.includeUntracked] - Whether to include untracked files in the change review.
 * @param {string} [options.ssotPath] - Explicit path to project SSOT rules file.
 * @param {ReadonlyArray<object>} [options.rules] - Optional pre-loaded rules to use directly.
 * @param {boolean} [options.silent] - Suppress console output during execution.
 * @param {boolean} [options.json] - Emit structured JSON in the report string.
 * @returns {Promise<object>} Deeply frozen gate run result.
 */
export async function runGate(options = {}) {
  const repositoryRoot = options.repositoryRoot ? path.resolve(options.repositoryRoot) : process.cwd();
  const errors = [];
  const warnings = [];
  const checks = [];
  const findings = [];

  let setupError = false;
  let verificationIncomplete = false;

  // 1. Verify repository root exists
  if (!fs.existsSync(repositoryRoot)) {
    setupError = true;
    errors.push(`Repository root directory does not exist: ${repositoryRoot}`);
  }

  // 2. Load rules (if no setup error so far)
  let activeRules = [];
  let ruleConflicts = Array.isArray(options.ruleConflicts) ? options.ruleConflicts : [];
  if (!setupError) {
    if (Array.isArray(options.rules)) {
      activeRules = options.rules;
    } else {
      try {
        const ruleLoadResult = loadRules({
          repositoryRoot,
          ssotPath: options.ssotPath,
          failClosedOnConflict: true,
        });

        if (ruleLoadResult.errors && ruleLoadResult.errors.length > 0) {
          setupError = true;
          errors.push(...ruleLoadResult.errors);
        }
        if (ruleLoadResult.conflicts && ruleLoadResult.conflicts.length > 0) {
          setupError = true;
          ruleConflicts = ruleLoadResult.conflicts;
          errors.push(`Rule conflicts detected: ${ruleLoadResult.conflicts.map((c) => c.ruleId).join(', ')}`);
        }
        activeRules = ruleLoadResult.rules || [];
      } catch (err) {
        setupError = true;
        errors.push(`Failed to load rules: ${err.message}`);
      }
    }
  }

  // 3. Inspect git diff
  let diffResult = null;
  if (!setupError) {
    if (options.diffResult) {
      diffResult = options.diffResult;
      if (!diffResult || typeof diffResult !== 'object' || !diffResult.success) {
        setupError = true;
        const diffErrors = (diffResult && Array.isArray(diffResult.errors) && diffResult.errors) || [
          'Provided diffResult indicates failure or is invalid',
        ];
        errors.push(...diffErrors);
      }
    } else {
      diffResult = readGitDiff({
        repositoryRoot,
        base: options.base,
        staged: options.staged,
        includeUntracked: options.includeUntracked,
      });

      if (!diffResult.success) {
        setupError = true;
        errors.push(...diffResult.errors);
      } else {
        if (diffResult.warnings && diffResult.warnings.length > 0) {
          warnings.push(...diffResult.warnings);
        }
      }
    }

    // Check untracked files policy if strict untracked checking requested
    if (
      !setupError &&
      diffResult &&
      (options.failOnUntracked || options.requireAllFilesTracked) &&
      Array.isArray(diffResult.untrackedFiles) &&
      diffResult.untrackedFiles.length > 0
    ) {
      verificationIncomplete = true;
      errors.push(
        `Incomplete untracked-file processing: ${diffResult.untrackedFiles.length} untracked file(s) present without being tracked or ingested.`
      );
    }
  }

  // 4. Run checks (only if setup and diff inspection succeeded)
  if (!setupError && diffResult && diffResult.success) {
    let checkDefinitions = [];
    if (options.checks !== undefined) {
      if (!Array.isArray(options.checks) || options.checks.length === 0) {
        verificationIncomplete = true;
        errors.push('No checks were provided or executed: required verification cannot be bypassed with an empty checks list.');
      } else {
        // Ensure mandatory baseline checks are not bypassed by checking function identity rather than caller-supplied names
        const customFns = new Set(
          options.checks.map((c) => (typeof c === 'function' ? c : c && typeof c.fn === 'function' ? c.fn : null))
        );
        const missingMandatory = MANDATORY_CHECKS.filter((m) => !customFns.has(m.fn));
        checkDefinitions = [...missingMandatory, ...options.checks];
      }
    } else {
      checkDefinitions = [...MANDATORY_CHECKS];
    }

    for (const checkDef of checkDefinitions) {
      let checkName = (checkDef && checkDef.name) || (typeof checkDef === 'function' ? checkDef.name : 'anonymous-check') || 'anonymous-check';
      const checkFn = typeof checkDef === 'function' ? checkDef : checkDef ? checkDef.fn : null;

      // Disambiguate custom checks that attempt to reuse a mandatory check name
      const matchingMandatory = MANDATORY_CHECKS.find((m) => m.fn === checkFn);
      if (matchingMandatory) {
        checkName = (checkDef && checkDef.name) || matchingMandatory.name;
      } else if (MANDATORY_CHECKS.some((m) => m.name === checkName)) {
        checkName = `custom:${checkName}`;
      }

      if (typeof checkFn !== 'function') {
        verificationIncomplete = true;
        const invalidMsg = `Check '${checkName}' is invalid: missing executable function.`;
        errors.push(invalidMsg);
        checks.push(
          Object.freeze({
            name: checkName,
            executed: false,
            skippedReason: null,
            violations: Object.freeze([]),
            errors: Object.freeze([invalidMsg]),
          })
        );
        continue;
      }

      try {
        const checkResult = checkFn({
          repositoryRoot,
          diffResult,
          rules: activeRules,
        });

        // Validate check result structure per Section 9 (malformed output must not pass)
        if (
          !checkResult ||
          typeof checkResult !== 'object' ||
          typeof checkResult.executed !== 'boolean' ||
          (checkResult.violations !== undefined && !Array.isArray(checkResult.violations))
        ) {
          verificationIncomplete = true;
          const malformedMsg = `Check '${checkName}' returned malformed output (expected object with boolean 'executed' and array 'violations').`;
          errors.push(malformedMsg);
          checks.push(
            Object.freeze({
              name: checkName,
              executed: false,
              skippedReason: null,
              violations: Object.freeze([]),
              errors: Object.freeze([malformedMsg]),
            })
          );
          continue;
        }

        // Check if check explicitly reports incomplete execution or errors
        const checkHasErrors = Array.isArray(checkResult.errors) && checkResult.errors.length > 0;
        const isExplicitlyIncomplete = checkResult.incomplete === true || (!checkResult.executed && !checkResult.skippedReason);

        if (checkHasErrors || isExplicitlyIncomplete) {
          verificationIncomplete = true;
          if (checkHasErrors) {
            errors.push(...checkResult.errors);
          }
          if (isExplicitlyIncomplete && !checkHasErrors) {
            errors.push(`Check '${checkName}' reported incomplete verification.`);
          }
        }

        checks.push(
          Object.freeze({
            name: checkName,
            executed: checkResult.executed,
            skippedReason: checkResult.skippedReason || null,
            violations: Object.freeze(checkResult.violations || []),
            errors: Object.freeze(checkResult.errors || []),
          })
        );

        // 5. Generate evidence-backed findings for violations
        if (Array.isArray(checkResult.violations) && checkResult.violations.length > 0) {
          for (const violation of checkResult.violations) {
            try {
              const finding = generateFinding(violation, { rules: activeRules });
              const validation = validateFindingEvidence(finding, {
                repositoryRoot,
                rules: activeRules,
                ruleConflicts,
              });

              const finalFinding = validation.finding || finding;
              findings.push(finalFinding);

              // Fail-closed check: if any finding status is verification-incomplete, overall gate fails
              if (finalFinding.status === FINDING_STATUSES.VERIFICATION_INCOMPLETE) {
                verificationIncomplete = true;
                if (validation.rejectionReason) {
                  errors.push(validation.rejectionReason);
                }
              }
            } catch (fErr) {
              verificationIncomplete = true;
              errors.push(`Finding generation error in '${checkName}': ${fErr.message}`);
            }
          }
        }
      } catch (cErr) {
        verificationIncomplete = true;
        const crashMsg = `Check '${checkName}' crashed: ${cErr.message}`;
        errors.push(crashMsg);
        checks.push(
          Object.freeze({
            name: checkName,
            executed: false,
            skippedReason: null,
            violations: Object.freeze([]),
            errors: Object.freeze([crashMsg]),
          })
        );
      }
    }
  }

  // Also include any pre-supplied findings (e.g. from tests or external pipeline stages)
  if (options.findings !== undefined && options.findings !== null) {
    if (!Array.isArray(options.findings)) {
      verificationIncomplete = true;
      errors.push("Field 'options.findings' must be an array of finding objects when provided.");
    } else {
      for (const f of options.findings) {
        const validation = validateFindingEvidence(f, {
          repositoryRoot,
          rules: activeRules,
          ruleConflicts,
        });

        if (!validation.valid && validation.status === FINDING_STATUSES.VERIFICATION_INCOMPLETE) {
          verificationIncomplete = true;
          if (validation.rejectionReason) {
            errors.push(validation.rejectionReason);
          }
        }

        const finalFinding = validation.finding || f;
        findings.push(finalFinding);

        if (finalFinding.status === FINDING_STATUSES.VERIFICATION_INCOMPLETE) {
          verificationIncomplete = true;
        }
      }
    }
  }

  // 6. Evaluate authoritative gate policy
  const policyOutcome = evaluateGatePolicy({
    setupError,
    verificationIncomplete,
    findings,
  });

  const runData = {
    decision: policyOutcome.decision,
    exitCode: policyOutcome.exitCode,
    summary: policyOutcome.summary,
    diff: diffResult,
    rules: Object.freeze(activeRules),
    findings: Object.freeze(findings),
    checks: Object.freeze(checks),
    warnings: Object.freeze(warnings),
    errors: Object.freeze(errors),
  };

  let reportText = '';
  try {
    reportText = options.json
      ? formatJsonReport(runData)
      : formatHumanReport(runData);

    if (options.outputJson) {
      try {
        const resolvedRepo = path.resolve(repositoryRoot);
        const resolvedOutputPath = path.resolve(resolvedRepo, options.outputJson);
        const relCheck = path.relative(resolvedRepo, resolvedOutputPath);
        if (isEscapingRelative(relCheck)) {
          throw new Error(`Output JSON path '${options.outputJson}' escapes the repository root.`);
        }

        if (process.platform === 'win32') {
          const pathWithoutDrive = resolvedOutputPath.replace(/^[a-zA-Z]:/, '');
          if (pathWithoutDrive.includes(':')) {
            throw new Error(`Output JSON path '${options.outputJson}' contains an invalid alternate data stream syntax.`);
          }
          const segments = pathWithoutDrive.split(/[\\/]/).filter(Boolean);
          for (const seg of segments) {
            const trimmed = seg.replace(/[\s.]+$/, '');
            const stem = trimmed.split('.')[0].trim();
            if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CLOCK\$)$/i.test(stem)) {
              throw new Error(`Output JSON path '${options.outputJson}' contains a reserved Windows device name.`);
            }
          }
        }

        const realRepo = fs.realpathSync(resolvedRepo);

        const targetDir = path.dirname(resolvedOutputPath);
        let checkDir = targetDir;
        while (!fs.existsSync(checkDir) && checkDir !== path.dirname(checkDir)) {
          checkDir = path.dirname(checkDir);
        }
        if (fs.existsSync(checkDir)) {
          const realCheckDir = fs.realpathSync(checkDir);
          const relReal = path.relative(realRepo, realCheckDir);
          if (isEscapingRelative(relReal)) {
            throw new Error(`Output JSON path '${options.outputJson}' resolves outside repository root via symlink.`);
          }
        }

        let fileLstat = null;
        try {
          fileLstat = fs.lstatSync(resolvedOutputPath);
        } catch (lstatErr) {
          if (lstatErr.code !== 'ENOENT') {
            throw new Error(`Failed to inspect output JSON path '${options.outputJson}': ${lstatErr.message}`);
          }
        }

        if (fileLstat) {
          if (fileLstat.isDirectory()) {
            throw new Error(`Output JSON path '${options.outputJson}' is a directory.`);
          }
          try {
            const realOutputFile = fs.realpathSync(resolvedOutputPath);
            const relRealFile = path.relative(realRepo, realOutputFile);
            if (isEscapingRelative(relRealFile)) {
              throw new Error(`Output JSON path '${options.outputJson}' resolves outside repository root via symlink.`);
            }
          } catch (realFileErr) {
            if (realFileErr.code === 'ENOENT' && fileLstat.isSymbolicLink()) {
              const rawLinkTarget = fs.readlinkSync(resolvedOutputPath);
              const resolvedLinkTarget = path.resolve(path.dirname(resolvedOutputPath), rawLinkTarget);
              const relLink = path.relative(realRepo, resolvedLinkTarget);
              if (isEscapingRelative(relLink)) {
                throw new Error(`Output JSON path '${options.outputJson}' resolves outside repository root via symlink.`);
              }
            } else {
              throw realFileErr;
            }
          }
        }

        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
        const jsonReportText = options.json ? reportText : formatJsonReport(runData);
        fs.writeFileSync(resolvedOutputPath, jsonReportText, 'utf8');
      } catch (ioErr) {
        throw new Error(`Failed to write JSON report to '${options.outputJson}': ${ioErr.message}`);
      }
    }
  } catch (reportErr) {
    const errorMsg = `Report formatting failed: ${reportErr.message}`;
    const finalExitCode = policyOutcome.exitCode === EXIT_CODES.SUCCESS
      ? EXIT_CODES.VERIFICATION_FAILURE
      : policyOutcome.exitCode;
    const finalDecision = policyOutcome.exitCode === EXIT_CODES.SUCCESS
      ? 'incomplete'
      : policyOutcome.decision;
    const finalErrors = Object.freeze([...errors, errorMsg]);

    if (!options.silent) {
      console.error(errorMsg);
    }

    return Object.freeze({
      success: false,
      exitCode: finalExitCode,
      decision: finalDecision,
      summary: errorMsg,
      report: errorMsg,
      findings: runData.findings,
      checks: runData.checks,
      diff: runData.diff,
      rules: runData.rules,
      warnings: runData.warnings,
      errors: finalErrors,
    });
  }

  if (!options.silent) {
    console.log(reportText);
  }

  return Object.freeze({
    success: policyOutcome.exitCode === EXIT_CODES.SUCCESS,
    exitCode: policyOutcome.exitCode,
    decision: policyOutcome.decision,
    summary: policyOutcome.summary,
    report: reportText,
    findings: runData.findings,
    checks: runData.checks,
    diff: runData.diff,
    rules: runData.rules,
    warnings: runData.warnings,
    errors: runData.errors,
  });
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------
const isDirectCliInvocation = () => {
  if (!process.argv || !process.argv[1]) return false;
  try {
    const currentFilePath = path.resolve(fileURLToPath(import.meta.url));
    const invokedFilePath = path.resolve(process.argv[1]);
    return currentFilePath === invokedFilePath;
  } catch {
    return false;
  }
};

if (isDirectCliInvocation()) {
  const args = process.argv.slice(2);
  const cliOptions = {
    repositoryRoot: process.cwd(),
    base: undefined,
    staged: false,
    includeUntracked: false,
    ssotPath: undefined,
    outputJson: undefined,
    json: false,
    silent: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--staged') {
      cliOptions.staged = true;
    } else if (arg === '--include-untracked') {
      cliOptions.includeUntracked = true;
    } else if (arg === '--json') {
      cliOptions.json = true;
    } else if (arg === '--silent') {
      cliOptions.silent = true;
    } else if (arg === '--base' && i + 1 < args.length) {
      cliOptions.base = args[++i];
    } else if (arg === '--repo' && i + 1 < args.length) {
      cliOptions.repositoryRoot = args[++i];
    } else if (arg === '--ssot' && i + 1 < args.length) {
      cliOptions.ssotPath = args[++i];
    } else if (arg === '--output-json' && i + 1 < args.length) {
      cliOptions.outputJson = args[++i];
    }
  }

  runGate(cliOptions)
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((err) => {
      console.error(`Fatal Gate Runner Error: ${err.message}`);
      process.exitCode = EXIT_CODES.SETUP_ERROR;
    });
}
