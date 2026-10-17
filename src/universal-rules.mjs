import { SEVERITIES } from './severities.mjs';
import { validateRule } from './rule-schema.mjs';

/**
 * Universal rules shipped with Bloat Checker V1.
 * Defined according to Section 4 of BLOAT_CHECKER_V1_BUILD_SPEC.md
 * and Section 7 of BLOAT_CHECKER_DISCUSSION.md.
 */
const RAW_UNIVERSAL_RULES = [
  Object.freeze({
    id: 'RULE-NO-UNUSED-LOCALS',
    description: 'Reject unused variables, parameters, dead imports, and unreferenced local functions.',
    applicability: 'staged changes in git diff',
    severity: SEVERITIES.MAJOR,
    enforcement: 'blocking',
    source: 'universal',
  }),
  Object.freeze({
    id: 'RULE-NO-SPECULATIVE-ABSTRACTIONS',
    description: 'Reject speculative wrappers, single-implementation interfaces, and premature abstraction layers.',
    applicability: 'staged changes in git diff',
    severity: SEVERITIES.MAJOR,
    enforcement: 'blocking',
    source: 'universal',
  }),
  Object.freeze({
    id: 'RULE-NO-UNNECESSARY-DEPENDENCIES',
    description: 'Reject new external runtime packages when standard runtime built-ins or existing code suffice.',
    applicability: 'package manifest and dependency declarations',
    severity: SEVERITIES.CRITICAL,
    enforcement: 'blocking',
    source: 'universal',
  }),
];

// Validate all universal rules at initialization to guarantee schema integrity
for (const rule of RAW_UNIVERSAL_RULES) {
  const result = validateRule(rule);
  if (!result.valid) {
    throw new Error(`Invalid universal rule definition '${rule.id}': ${result.errors.join(', ')}`);
  }
}

/**
 * Immutable collection of universal rules shipped with Bloat Checker.
 */
export const UNIVERSAL_RULES = Object.freeze(RAW_UNIVERSAL_RULES);
