/**
 * Bloat Checker V1 — Report Formatter
 *
 * Implements Unit 13 structured reporting per Section 11 of BLOAT_CHECKER_V1_BUILD_SPEC.md:
 * - Deterministic human-readable report answering the 8 core review questions
 * - Stable, deterministic machine-readable JSON report
 * - Accurate check-state classification (COMPLETED, SKIPPED, FAILED)
 * - Zero decision recalculation or policy modification
 */

export const SCHEMA_VERSION = '1.0.0';

/**
 * Deterministically sorts findings using stable property tie-breakers.
 * Order:
 * 1. filePath (lexicographical)
 * 2. startLine (numerical ascending)
 * 3. endLine (numerical ascending)
 * 4. ruleId (lexicographical)
 * 5. id (lexicographical)
 * 6. title (lexicographical)
 * 7. evidence string (lexicographical)
 *
 * @param {ReadonlyArray<object>} findings
 * @returns {Array<object>} Stably sorted shallow copy of findings
 */
export function sortFindingsDeterministically(findings) {
  if (!Array.isArray(findings)) return [];

  return [...findings].sort((a, b) => {
    // 1. File path
    const pathA = (a?.location?.filePath || '').trim();
    const pathB = (b?.location?.filePath || '').trim();
    if (pathA < pathB) return -1;
    if (pathA > pathB) return 1;

    // 2. Start line
    const startA = a?.location?.lineRange?.start ?? (typeof a?.line === 'number' ? a.line : 0);
    const startB = b?.location?.lineRange?.start ?? (typeof b?.line === 'number' ? b.line : 0);
    if (startA !== startB) return startA - startB;

    // 3. End line
    const endA = a?.location?.lineRange?.end ?? startA;
    const endB = b?.location?.lineRange?.end ?? startB;
    if (endA !== endB) return endA - endB;

    // 4. Rule ID
    const ruleA = (a?.rule?.id || '').trim();
    const ruleB = (b?.rule?.id || '').trim();
    if (ruleA < ruleB) return -1;
    if (ruleA > ruleB) return 1;

    // 5. Finding ID
    const idA = (a?.id || '').trim();
    const idB = (b?.id || '').trim();
    if (idA < idB) return -1;
    if (idA > idB) return 1;

    // 6. Title
    const titleA = (a?.title || '').trim();
    const titleB = (b?.title || '').trim();
    if (titleA < titleB) return -1;
    if (titleA > titleB) return 1;

    // 7. Evidence tie-breaker
    const evA = typeof a?.evidence === 'string' ? a.evidence : JSON.stringify(a?.evidence || '');
    const evB = typeof b?.evidence === 'string' ? b.evidence : JSON.stringify(b?.evidence || '');
    if (evA < evB) return -1;
    if (evA > evB) return 1;

    return 0;
  });
}

/**
 * Deterministically sorts checks by check name.
 *
 * @param {ReadonlyArray<object>} checks
 * @returns {Array<object>}
 */
export function sortChecksDeterministically(checks) {
  if (!Array.isArray(checks)) return [];
  return [...checks].sort((a, b) => {
    const nameA = (a?.name || '').trim();
    const nameB = (b?.name || '').trim();
    if (nameA < nameB) return -1;
    if (nameA > nameB) return 1;
    return 0;
  });
}

/**
 * Classifies the execution state of an analyzer check accurately without labeling failures as skips.
 *
 * @param {object} check
 * @returns {'COMPLETED' | 'SKIPPED' | 'FAILED'}
 */
export function classifyCheckState(check) {
  if (!check || typeof check !== 'object') return 'FAILED';
  const hasErrors = Array.isArray(check.errors) && check.errors.length > 0;
  if (hasErrors || (!check.executed && !check.skippedReason)) {
    return 'FAILED';
  }
  if (!check.executed) {
    return 'SKIPPED';
  }
  return 'COMPLETED';
}

/**
 * Computes deterministic statistics summarizing gate execution.
 *
 * @param {object} runData
 * @returns {object}
 */
export function computeReportStats(runData) {
  const checks = Array.isArray(runData?.checks) ? runData.checks : [];
  const findings = Array.isArray(runData?.findings) ? runData.findings : [];

  let checksCompleted = 0;
  let checksSkipped = 0;
  let checksFailed = 0;

  for (const c of checks) {
    const state = classifyCheckState(c);
    if (state === 'COMPLETED') checksCompleted++;
    else if (state === 'SKIPPED') checksSkipped++;
    else checksFailed++;
  }

  let blockingCount = 0;
  let verifiedCount = 0;
  let unverifiedCount = 0;
  let incompleteCount = 0;

  for (const f of findings) {
    if (f?.blocksWorkflow === true) blockingCount++;
    if (f?.status === 'verified') verifiedCount++;
    else if (f?.status === 'unverified') unverifiedCount++;
    else if (f?.status === 'verification-incomplete') incompleteCount++;
  }

  return {
    totalChecks: checks.length,
    checksCompleted,
    checksSkipped,
    checksFailed,
    totalFindings: findings.length,
    blockingFindings: blockingCount,
    verifiedFindings: verifiedCount,
    unverifiedFindings: unverifiedCount,
    incompleteFindings: incompleteCount,
  };
}

/**
 * Formats a concise, actionable human-readable report answering Section 11 of BLOAT_CHECKER_V1_BUILD_SPEC.md:
 * 1. What changed?
 * 2. What rule or concern was identified?
 * 3. Where is the evidence?
 * 4. Why does it matter?
 * 5. What verification was performed?
 * 6. Is it verified, uncertain, or incomplete?
 * 7. Does it block the protected workflow?
 * 8. What should happen next?
 *
 * @param {object} runData
 * @returns {string} Human-readable report text.
 */
export function formatHumanReport(runData) {
  if (!runData || typeof runData !== 'object') {
    throw new TypeError('formatHumanReport requires a valid runData object');
  }

  const { decision = 'error', exitCode = 3, diff, rules, findings, checks, warnings, errors, verdict, goal, isPostImplementation } = runData;
  const lines = [];

  const displayVerdict = verdict || String(decision).toUpperCase();
  lines.push('================================================================');
  if (isPostImplementation) {
    lines.push(' BLOAT CHECKER POST-IMPLEMENTATION GATE REPORT');
    lines.push(` Verdict  : ${verdict || String(decision).toUpperCase()} (Exit Code: ${exitCode})`);
    if (goal) {
      lines.push(` Goal     : ${goal}`);
    } else {
      lines.push(' Goal     : (Not provided — goal alignment unverified)');
    }
  } else {
    lines.push(' BLOAT CHECKER V1 GATE REPORT');
    lines.push(` Decision : ${String(decision).toUpperCase()} (Exit Code: ${exitCode})`);
  }
  lines.push('================================================================');
  lines.push('');

  // 1. What changed?
  lines.push('1. WHAT CHANGED:');
  if (diff && diff.success) {
    const changedCount = Array.isArray(diff.changedFiles) ? diff.changedFiles.length : 0;
    const baseRev = diff.base || (diff.staged ? 'staged changes' : 'working tree');
    lines.push(`   - Base revision: ${baseRev}`);
    lines.push(`   - Changed files inspected: ${changedCount}`);
    if (Array.isArray(diff.changedFiles)) {
      for (const f of diff.changedFiles.slice(0, 10)) {
        lines.push(`     • [${f.status || 'M'}] ${f.path}`);
      }
      if (changedCount > 10) {
        lines.push(`     • ... and ${changedCount - 10} more file(s)`);
      }
    }
    if (Array.isArray(diff.untrackedFiles) && diff.untrackedFiles.length > 0) {
      lines.push(`   - Untracked files detected: ${diff.untrackedFiles.length}`);
    }
    if (warnings && warnings.length > 0) {
      for (const w of warnings) {
        lines.push(`   - Warning: ${w}`);
      }
    }
  } else {
    lines.push('   - Diff inspection failed or was not available');
  }
  lines.push('');

  // 2. Checks Executed
  lines.push('2. CHECKS EXECUTED:');
  lines.push(`   - Active rules loaded: ${Array.isArray(rules) ? rules.length : 0}`);
  const sortedChecks = sortChecksDeterministically(checks || []);
  if (sortedChecks.length > 0) {
    for (const c of sortedChecks) {
      const state = classifyCheckState(c);
      let statusDetail = state;
      if (state === 'SKIPPED') {
        statusDetail = `SKIPPED (${c.skippedReason || 'N/A'})`;
      } else if (state === 'FAILED') {
        const firstErr = Array.isArray(c.errors) && c.errors[0] ? `: ${c.errors[0]}` : '';
        statusDetail = `FAILED/INCOMPLETE${firstErr}`;
      }
      const vCount = Array.isArray(c.violations) ? c.violations.length : 0;
      lines.push(`   - [${c.name || 'anonymous'}]: ${statusDetail} (${vCount} violation(s) flagged)`);
    }
  } else {
    lines.push('   - No checks executed');
  }
  lines.push('');

  // 3. Findings Detail (Answers 2, 3, 4, 5, 6, 7, 8)
  const sortedFindings = sortFindingsDeterministically(findings || []);
  lines.push(`3. FINDINGS (${sortedFindings.length}):`);
  if (sortedFindings.length === 0) {
    lines.push('   No quality violations detected.');
  } else {
    sortedFindings.forEach((f, idx) => {
      lines.push(`   --- Finding #${idx + 1}: ${f.id || 'N/A'} ---`);
      lines.push(`   • Title / Concern   : ${f.title || 'Untitled finding'}`);

      const ruleId = f.rule ? (f.rule.id || (f.rule.isNewRule ? 'PROPOSED-NEW-RULE' : 'N/A')) : 'N/A';
      const ruleSource = f.rule ? (f.rule.source || (f.rule.isNewRule ? 'discovered proposal' : 'unknown')) : 'unknown';
      lines.push(`   • Applicable Rule   : ${ruleId} (source: ${ruleSource})`);
      if (f.rule?.isNewRule && f.rule.statement) {
        lines.push(`     Proposed Statement: ${f.rule.statement}`);
      }

      const filePath = f.location?.filePath || 'unknown_file';
      let lineStr = '';
      if (f.location?.lineRange) {
        const { start, end } = f.location.lineRange;
        lineStr = start === end ? `:${start}` : `:${start}-${end}`;
      } else if (typeof f.line === 'number') {
        lineStr = `:${f.line}`;
      }
      lines.push(`   • Location          : ${filePath}${lineStr}`);

      const evidenceStr = typeof f.evidence === 'string'
        ? f.evidence
        : JSON.stringify(f.evidence ?? 'N/A');
      lines.push(`   • Evidence          : ${evidenceStr}`);
      lines.push(`   • Why it Matters    : ${f.impact || f.explanation || 'Introduces complexity or debt'}`);

      const valPerformed = f.validation?.performed || 'Static check';
      const valResult = f.validation?.result || 'Automated validation';
      lines.push(`   • Verification      : ${valPerformed} -> ${valResult}`);
      lines.push(`   • Certainty/Status  : ${f.status || 'unverified'} (Severity: ${f.severity || 'major'})`);

      if (f.rejectionReason) {
        lines.push(`     Validation Note   : ${f.rejectionReason}`);
      }

      lines.push(`   • Blocks Workflow?  : ${f.blocksWorkflow ? 'YES (BLOCKING)' : 'NO (ADVISORY/NON-BLOCKING)'}`);
      if (f.blockReason) {
        lines.push(`     Reason            : ${f.blockReason}`);
      }
      lines.push(`   • Recommended Action: ${f.nextAction || 'Review and remediate the cited bloat'}`);
      lines.push('');
    });
  }

  // 4. Verification Failures & System Errors
  if (Array.isArray(errors) && errors.length > 0) {
    lines.push('4. ERRORS & VERIFICATION FAILURES:');
    for (const err of errors) {
      lines.push(`   • ${err}`);
    }
    lines.push('');
  }

  // 5. Summary decision line
  lines.push('================================================================');
  lines.push(` SUMMARY: ${String(decision).toUpperCase()} — Exit Code ${exitCode}`);
  lines.push('================================================================');

  return lines.join('\n');
}

/**
 * Formats a deterministic, machine-readable JSON report suitable for CI automation.
 *
 * @param {object} runData
 * @returns {string} Deterministic formatted JSON string
 */
export function formatJsonReport(runData) {
  if (!runData || typeof runData !== 'object') {
    throw new TypeError('formatJsonReport requires a valid runData object');
  }

  const sortedFindings = sortFindingsDeterministically(runData.findings || []);
  const sortedChecks = sortChecksDeterministically(runData.checks || []);
  const stats = computeReportStats(runData);

  const structured = {
    schemaVersion: SCHEMA_VERSION,
    decision: runData.decision || 'error',
    verdict: runData.verdict || (runData.decision === 'pass' ? 'PASS' : runData.decision === 'pass_with_warnings' ? 'PASS WITH WARNINGS' : 'FAIL'),
    goal: runData.goal || null,
    isPostImplementation: Boolean(runData.isPostImplementation),
    exitCode: typeof runData.exitCode === 'number' ? runData.exitCode : 3,
    summary: runData.summary || '',
    stats,
    checks: sortedChecks.map((c) => {
      const state = classifyCheckState(c);
      return {
        name: c.name || 'anonymous-check',
        state,
        executed: Boolean(c.executed),
        skippedReason: c.skippedReason || null,
        violationsCount: Array.isArray(c.violations) ? c.violations.length : 0,
        errors: Array.isArray(c.errors) ? [...c.errors] : [],
      };
    }),
    findings: sortedFindings.map((f) => ({
      id: f.id || 'N/A',
      category: f.category || 'unnecessary-complexity',
      severity: f.severity || 'major',
      status: f.status || 'unverified',
      title: f.title || '',
      explanation: f.explanation || f.details || '',
      location: {
        filePath: f.location?.filePath || 'unknown_file',
        lineRange: f.location?.lineRange || null,
      },
      evidence: f.evidence ?? 'N/A',
      rule: f.rule
        ? {
            id: f.rule.id || null,
            source: f.rule.source || null,
            ...(f.rule.isNewRule ? { isNewRule: true, statement: f.rule.statement || null } : {}),
          }
        : null,
      impact: f.impact || '',
      validation: f.validation
        ? {
            performed: f.validation.performed || '',
            result: f.validation.result || '',
          }
        : null,
      blocksWorkflow: Boolean(f.blocksWorkflow),
      blockReason: f.blockReason || null,
      rejectionReason: f.rejectionReason || null,
      nextAction: f.nextAction || '',
    })),
    diff: runData.diff
      ? {
          base: runData.diff.base || null,
          current: runData.diff.current || null,
          staged: Boolean(runData.diff.staged),
          changedFilesCount: Array.isArray(runData.diff.changedFiles) ? runData.diff.changedFiles.length : 0,
          untrackedFilesCount: Array.isArray(runData.diff.untrackedFiles) ? runData.diff.untrackedFiles.length : 0,
        }
      : null,
    warnings: Array.isArray(runData.warnings) ? [...runData.warnings] : [],
    errors: Array.isArray(runData.errors) ? [...runData.errors] : [],
  };

  return JSON.stringify(structured, null, 2);
}
