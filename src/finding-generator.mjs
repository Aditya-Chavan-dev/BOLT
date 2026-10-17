import { SEVERITIES, FINDING_STATUSES } from './severities.mjs';
import { validateFinding } from './finding-schema.mjs';

const ALLOWED_SEVERITIES = new Set(Object.values(SEVERITIES));
const ALLOWED_STATUSES = new Set(Object.values(FINDING_STATUSES));

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function sanitizeRuleId(ruleId) {
  if (typeof ruleId !== 'string' || ruleId.trim().length === 0) {
    return 'RULE-UNKNOWN';
  }
  const sanitized = ruleId.trim().replace(/[^a-zA-Z0-9_.-]/g, '_');
  return sanitized.length > 0 ? sanitized : 'RULE-UNKNOWN';
}

function sanitizeFilePath(filePath) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    return 'unknown_file';
  }
  const sanitized = filePath
    .trim()
    .replace(/[\\/]/g, '_')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized.length > 0 ? sanitized : 'unknown_file';
}

function sanitizeLineNumber(line) {
  if (Number.isInteger(line) && line > 0) {
    return line;
  }
  if (typeof line === 'string' && /^\d+$/.test(line.trim())) {
    const parsed = parseInt(line.trim(), 10);
    if (parsed > 0) {
      return parsed;
    }
  }
  return 0;
}

function createStableFindingId(ruleId, filePath, line) {
  const sanitizedRule = sanitizeRuleId(ruleId);
  const sanitizedPath = sanitizeFilePath(filePath);
  const sanitizedLine = sanitizeLineNumber(line);
  return `FINDING-${sanitizedRule}-${sanitizedPath}-${sanitizedLine}`;
}


/**
 * Determines whether a finding blocks the protected workflow per Section 9 of BLOAT_CHECKER_V1_BUILD_SPEC.md.
 * Policy:
 * - Only VERIFIED critical and major violations block.
 * - UNVERIFIED and VERIFICATION_INCOMPLETE findings NEVER block, regardless of severity.
 * - MINOR findings/suggestions do not block by default.
 *
 * @param {string} severity - Severity level ('critical', 'major', 'minor').
 * @param {string} status - Verification status ('verified', 'unverified', 'verification-incomplete').
 * @returns {{ blocks: boolean, reason: string }}
 */
function evaluateWorkflowBlocking(severity, status) {
  if (status !== FINDING_STATUSES.VERIFIED) {
    return {
      blocks: false,
      reason: `Status is '${status}'. Unverified and verification-incomplete findings do not block by default per V1 policy.`,
    };
  }

  if (severity === SEVERITIES.CRITICAL || severity === SEVERITIES.MAJOR) {
    return {
      blocks: true,
      reason: `Verified ${severity} violation blocks protected workflow per V1 policy.`,
    };
  }

  return {
    blocks: false,
    reason: `Minor findings report advisory diagnostics without blocking by default per V1 policy.`,
  };
}

/**
 * Generates an evidence-backed finding from check violation diagnostics per Section 7 of BLOAT_CHECKER_V1_BUILD_SPEC.md.
 *
 * NOTE: validateFinding() is used exclusively for structural schema compliance (property types and required fields).
 * It does NOT establish factual correctness or empirical proof; factual verification is conveyed solely by 'status'.
 *
 * @param {object} violation - Raw violation diagnostic from an analyzer or scanner.
 * @param {string} violation.ruleId - Identifier of the violated rule.
 * @param {string} violation.filePath - File where violation occurred.
 * @param {number} [violation.line] - Line number of violation.
 * @param {string} [violation.status] - Verification status ('verified', 'unverified', 'verification-incomplete').
 * @param {string} violation.evidence - Reproducible code excerpt or analyzer output.
 * @param {string} [violation.category] - Finding category (defaults to 'unnecessary-complexity').
 * @param {string} [violation.title] - Short title describing the finding.
 * @param {string} [violation.details] - Detailed explanation.
 * @param {string} [violation.impact] - Why the violation matters in this project.
 * @param {string} [violation.nextAction] - Recommended remediation step.
 * @param {object} [violation.validation] - Validation performed and result.
 * @param {object} context
 * @param {ReadonlyArray<object>} context.rules - Active rule set to resolve rule metadata.
 * @returns {object} Deeply frozen, structurally validated finding object.
 */
export function generateFinding(violation, context = {}) {
  if (!violation || typeof violation !== 'object' || Array.isArray(violation)) {
    throw new TypeError('generateFinding requires a non-null violation object');
  }

  const rules = Array.isArray(context.rules) ? context.rules : [];
  const rawRuleId =
    violation.ruleId ||
    (violation.rule && typeof violation.rule === 'object' && violation.rule.id) ||
    undefined;
  const matchedRule = rawRuleId ? rules.find((r) => r.id === rawRuleId) : undefined;

  // Resolve severity
  let severity = matchedRule ? matchedRule.severity : SEVERITIES.MAJOR;
  if (violation.severity !== undefined && violation.severity !== null) {
    if (ALLOWED_SEVERITIES.has(violation.severity)) {
      severity = violation.severity;
    } else {
      throw new TypeError(
        `Invalid violation severity '${violation.severity}'. Allowed values are: ${Array.from(ALLOWED_SEVERITIES).join(', ')}`
      );
    }
  }

  // Resolve status: accept explicit status if valid, support 'potential' alias, or default to verified
  let status = FINDING_STATUSES.VERIFIED;
  if (violation.status !== undefined && violation.status !== null) {
    if (violation.status === 'potential' || violation.status === FINDING_STATUSES.UNVERIFIED) {
      status = FINDING_STATUSES.UNVERIFIED;
    } else if (ALLOWED_STATUSES.has(violation.status)) {
      status = violation.status;
    } else {
      throw new TypeError(
        `Invalid violation status '${violation.status}'. Allowed values are: ${Array.from(ALLOWED_STATUSES).join(', ')}, potential`
      );
    }
  }

  // Resolve rule representation
  let rule;
  if (violation.rule && typeof violation.rule === 'object' && !Array.isArray(violation.rule)) {
    rule = Object.freeze({ ...violation.rule });
  } else if (violation.isNewRule === true) {
    rule = Object.freeze({
      isNewRule: true,
      statement:
        (typeof violation.statement === 'string' && violation.statement.trim()) ||
        (typeof violation.details === 'string' && violation.details.trim()) ||
        'Proposed rule statement pending formal adoption',
    });
  } else {
    rule = Object.freeze({
      id: matchedRule ? matchedRule.id : sanitizeRuleId(rawRuleId),
      source: matchedRule ? matchedRule.source : (violation.ruleSource || 'unknown'),
    });
  }

  // Resolve location
  const resolvedFilePath = isNonEmptyString(violation.filePath) ? violation.filePath.trim() : 'unknown_file';
  const validLine = sanitizeLineNumber(violation.line);

  let resolvedLineRange = undefined;
  if (violation.lineRange) {
    if (
      typeof violation.lineRange === 'object' &&
      Number.isInteger(violation.lineRange.start) &&
      Number.isInteger(violation.lineRange.end) &&
      violation.lineRange.start > 0 &&
      violation.lineRange.end >= violation.lineRange.start
    ) {
      resolvedLineRange = Object.freeze({
        start: violation.lineRange.start,
        end: violation.lineRange.end,
      });
    } else if (typeof violation.lineRange === 'string' && violation.lineRange.trim().length > 0) {
      resolvedLineRange = violation.lineRange.trim();
    }
  } else if (validLine > 0) {
    resolvedLineRange = Object.freeze({
      start: validLine,
      end: validLine,
    });
  }

  const location = Object.freeze({
    filePath: resolvedFilePath,
    ...(resolvedLineRange !== undefined ? { lineRange: resolvedLineRange } : {}),
  });

  const idRule = rule.isNewRule ? (rule.id || 'NEW-RULE') : rule.id;
  const idLine = validLine > 0 ? validLine : (resolvedLineRange && resolvedLineRange.start ? resolvedLineRange.start : 0);
  const id = createStableFindingId(idRule, resolvedFilePath, idLine);

  const category = (isNonEmptyString(violation.category) && violation.category.trim()) || 'unnecessary-complexity';
  const title = (isNonEmptyString(violation.title) && violation.title.trim()) || `Code quality violation: ${idRule}`;
  const explanation =
    (isNonEmptyString(violation.details) && violation.details.trim()) ||
    (isNonEmptyString(violation.explanation) && violation.explanation.trim()) ||
    `Deterministic violation of ${idRule} detected at ${resolvedFilePath}${validLine > 0 ? `:${validLine}` : ''}.`;

  let evidence = 'N/A';
  if (isNonEmptyString(violation.evidence)) {
    evidence = violation.evidence.trim();
  } else if (
    violation.evidence &&
    typeof violation.evidence === 'object' &&
    !Array.isArray(violation.evidence) &&
    (isNonEmptyString(violation.evidence.excerpt) || isNonEmptyString(violation.evidence.output))
  ) {
    evidence = Object.freeze({ ...violation.evidence });
  }

  const impact =
    (isNonEmptyString(violation.impact) && violation.impact.trim()) ||
    'Introduces avoidable code bloat, increasing maintenance burden and review friction.';

  const validation = Object.freeze({
    performed:
      (violation.validation && isNonEmptyString(violation.validation.performed) && violation.validation.performed.trim()) ||
      'Deterministic analyzer inspection',
    result:
      (violation.validation && isNonEmptyString(violation.validation.result) && violation.validation.result.trim()) ||
      'Reproducible violation evidence confirmed in diff',
  });

  const nextAction =
    (isNonEmptyString(violation.nextAction) && violation.nextAction.trim()) ||
    `Review ${resolvedFilePath} and remove unnecessary logic to comply with ${idRule}.`;

  const blockingPolicy = evaluateWorkflowBlocking(severity, status);

  const findingCandidate = {
    id,
    category,
    severity,
    status,
    title,
    explanation,
    location,
    evidence,
    rule,
    impact,
    validation,
    nextAction,
    blocksWorkflow: blockingPolicy.blocks,
    blockReason: blockingPolicy.reason,
  };

  // Structural validation only: confirms syntactic schema conformance, not factual proof
  const validationResult = validateFinding(findingCandidate);
  if (!validationResult.valid) {
    throw new Error(
      `Generated finding failed structural schema validation: ${validationResult.errors.join('; ')}`
    );
  }

  return Object.freeze(findingCandidate);
}
