/**
 * Finding severity levels and verification statuses for Bloat Checker.
 * Defined according to BLOAT_CHECKER_V1_BUILD_SPEC.md (Sections 7, 8, and 9)
 * and BLOAT_CHECKER_DISCUSSION.md (Sections 9 and 10).
 */

/**
 * Explicit severity levels defined in BLOAT_CHECKER_V1_BUILD_SPEC.md (Section 9).
 * Note: Suggestions are classified under 'minor' ("Minor suggestions") per lines 253 and 351,
 * rather than existing as an independent 4th severity level.
 */
export const SEVERITIES = Object.freeze({
  CRITICAL: 'critical',
  MAJOR: 'major',
  MINOR: 'minor',
});

/**
 * Finding verification statuses defined in BLOAT_CHECKER_V1_BUILD_SPEC.md (Sections 7 and 8).
 */
export const FINDING_STATUSES = Object.freeze({
  VERIFIED: 'verified',
  UNVERIFIED: 'unverified',
  VERIFICATION_INCOMPLETE: 'verification-incomplete',
});
