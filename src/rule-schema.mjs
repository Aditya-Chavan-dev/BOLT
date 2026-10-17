import { SEVERITIES } from './severities.mjs';

const ALLOWED_SEVERITIES = new Set(Object.values(SEVERITIES));

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidApplicability(value) {
  if (isNonEmptyString(value)) {
    return true;
  }
  if (isPlainObject(value)) {
    return true;
  }
  return false;
}

function isValidEnforcement(value) {
  if (typeof value === 'boolean') {
    return true;
  }
  if (isNonEmptyString(value)) {
    return true;
  }
  return false;
}

/**
 * Validates the structural schema of a rule object per Section 4 of BLOAT_CHECKER_V1_BUILD_SPEC.md.
 * Rules should have stable identifiers, a description, applicability conditions, severity,
 * enforcement status, and a way to cite the source.
 *
 * @param {unknown} rule - The rule candidate to validate.
 * @returns {{ valid: boolean, errors: string[] }} Validation result with list of error messages.
 */
export function validateRule(rule) {
  if (!isPlainObject(rule)) {
    return {
      valid: false,
      errors: ['Rule must be a non-null object'],
    };
  }

  const errors = [];

  if (!isNonEmptyString(rule.id)) {
    errors.push("Field 'id' must be a non-empty string");
  }

  if (!isNonEmptyString(rule.description)) {
    errors.push("Field 'description' must be a non-empty string");
  }

  if (!isValidApplicability(rule.applicability)) {
    errors.push("Field 'applicability' must be a non-empty string or a non-null object");
  }

  if (!ALLOWED_SEVERITIES.has(rule.severity)) {
    errors.push(`Field 'severity' must be one of: ${Array.from(ALLOWED_SEVERITIES).join(', ')}`);
  }

  if (!isValidEnforcement(rule.enforcement)) {
    errors.push("Field 'enforcement' must be a boolean or a non-empty string");
  }

  if (!isNonEmptyString(rule.source)) {
    errors.push("Field 'source' must be a non-empty string");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
