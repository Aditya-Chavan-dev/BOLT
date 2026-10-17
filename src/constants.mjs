/**
 * Stable machine-readable exit codes for Bloat Checker.
 * Defined according to BLOAT_CHECKER_V1_BUILD_SPEC.md (Section 9).
 */
export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  POLICY_FAILURE: 1,
  VERIFICATION_FAILURE: 2,
  SETUP_ERROR: 3,
});
