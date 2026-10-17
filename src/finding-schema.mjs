import { SEVERITIES, FINDING_STATUSES } from './severities.mjs';

const ALLOWED_SEVERITIES = new Set(Object.values(SEVERITIES));
const ALLOWED_STATUSES = new Set(Object.values(FINDING_STATUSES));

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidLineRange(range) {
  if (typeof range === 'string') {
    return range.trim().length > 0;
  }
  if (isPlainObject(range)) {
    const { start, end } = range;
    return (
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start > 0 &&
      end >= start
    );
  }
  return false;
}

function isValidEvidence(evidence) {
  if (isNonEmptyString(evidence)) {
    return true;
  }
  if (isPlainObject(evidence)) {
    return isNonEmptyString(evidence.excerpt) || isNonEmptyString(evidence.output);
  }
  return false;
}

function validateLocation(location, errors) {
  if (!isPlainObject(location)) {
    errors.push("Field 'location' must be a non-null object");
    return;
  }
  if (!isNonEmptyString(location.filePath)) {
    errors.push("Field 'location.filePath' must be a non-empty string");
  }
  if (location.lineRange !== undefined && !isValidLineRange(location.lineRange)) {
    errors.push("Field 'location.lineRange' must be a non-empty string or an object with positive integer start and end (end >= start)");
  }
}

function validateRule(rule, errors) {
  if (!isPlainObject(rule)) {
    errors.push("Field 'rule' must be a non-null object");
    return;
  }
  if (rule.isNewRule === true) {
    if (!isNonEmptyString(rule.statement)) {
      errors.push("Field 'rule.statement' is required as a non-empty string for new rule proposals");
    }
  } else {
    if (!isNonEmptyString(rule.id)) {
      errors.push("Field 'rule.id' must be a non-empty string when referencing an existing rule");
    }
    if (!isNonEmptyString(rule.source)) {
      errors.push("Field 'rule.source' must be a non-empty string when referencing an existing rule");
    }
  }
}

function validateValidation(validation, errors) {
  if (!isPlainObject(validation)) {
    errors.push("Field 'validation' must be a non-null object with 'performed' and 'result' properties");
    return;
  }
  if (!isNonEmptyString(validation.performed)) {
    errors.push("Field 'validation.performed' must be a non-empty string");
  }
  if (!isNonEmptyString(validation.result)) {
    errors.push("Field 'validation.result' must be a non-empty string");
  }
}

/**
 * Validates the structural schema of a finding object per Section 7 of BLOAT_CHECKER_V1_BUILD_SPEC.md.
 * Structural validity is purely syntactic and does NOT imply factual verification or workflow blocking.
 *
 * @param {unknown} finding - The finding candidate to validate.
 * @returns {{ valid: boolean, errors: string[] }} Validation result with list of error messages.
 */
export function validateFinding(finding) {
  if (!isPlainObject(finding)) {
    return {
      valid: false,
      errors: ['Finding must be a non-null object'],
    };
  }

  const errors = [];

  if (!isNonEmptyString(finding.id)) {
    errors.push("Field 'id' must be a non-empty string");
  }

  if (!isNonEmptyString(finding.category)) {
    errors.push("Field 'category' must be a non-empty string");
  }

  if (!ALLOWED_SEVERITIES.has(finding.severity)) {
    errors.push(`Field 'severity' must be one of: ${Array.from(ALLOWED_SEVERITIES).join(', ')}`);
  }

  if (!ALLOWED_STATUSES.has(finding.status)) {
    errors.push(`Field 'status' must be one of: ${Array.from(ALLOWED_STATUSES).join(', ')}`);
  }

  if (!isNonEmptyString(finding.title)) {
    errors.push("Field 'title' must be a non-empty string");
  }

  if (!isNonEmptyString(finding.explanation)) {
    errors.push("Field 'explanation' must be a non-empty string");
  }

  validateLocation(finding.location, errors);

  if (!isValidEvidence(finding.evidence)) {
    errors.push("Field 'evidence' must be a non-empty string or an object containing 'excerpt' or 'output'");
  }

  validateRule(finding.rule, errors);

  if (!isNonEmptyString(finding.impact)) {
    errors.push("Field 'impact' must be a non-empty string");
  }

  validateValidation(finding.validation, errors);

  if (!isNonEmptyString(finding.nextAction)) {
    errors.push("Field 'nextAction' must be a non-empty string");
  }

  if (typeof finding.blocksWorkflow !== 'boolean') {
    errors.push("Field 'blocksWorkflow' must be a boolean");
  }

  if (finding.blockReason !== undefined && !isNonEmptyString(finding.blockReason)) {
    errors.push("Field 'blockReason' must be a non-empty string if provided");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
