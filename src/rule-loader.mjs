import fs from 'node:fs';
import path from 'node:path';
import { UNIVERSAL_RULES } from './universal-rules.mjs';
import { validateRule } from './rule-schema.mjs';

const DEFAULT_SSOT_CANDIDATES = Object.freeze([
  'bloat-rules.json',
  '.bloat-rules.json',
]);

function areRulesConflicting(ruleA, ruleB) {
  if (ruleA.id !== ruleB.id) {
    return false;
  }
  return (
    ruleA.severity !== ruleB.severity ||
    ruleA.enforcement !== ruleB.enforcement ||
    ruleA.description !== ruleB.description ||
    JSON.stringify(ruleA.applicability) !== JSON.stringify(ruleB.applicability)
  );
}

/**
 * Loads and merges universal rules with project-specific SSOT rules per Section 4 of BLOAT_CHECKER_V1_BUILD_SPEC.md.
 * Discovers project SSOT or accepts an explicit path. Detects conflicts and surfaces missing SSOT without guessing.
 *
 * @param {object} [options]
 * @param {string} [options.repositoryRoot] - Target repository root directory (defaults to process.cwd()).
 * @param {string} [options.ssotPath] - Explicit path to project SSOT rule file.
 * @param {boolean} [options.requireSsot] - If true, missing SSOT is treated as an error (setup failure).
 * @returns {{
 *   success: boolean,
 *   rules: ReadonlyArray<object>,
 *   ssotPath: string | null,
 *   conflicts: ReadonlyArray<{ id: string, message: string, rules: Array<object> }>,
 *   warnings: ReadonlyArray<string>,
 *   errors: ReadonlyArray<string>
 * }}
 */
export function loadRules(options = {}) {
  const repositoryRoot = options.repositoryRoot ? path.resolve(options.repositoryRoot) : process.cwd();
  const requireSsot = Boolean(options.requireSsot);

  if (!fs.existsSync(repositoryRoot)) {
    return {
      success: false,
      rules: Object.freeze([...UNIVERSAL_RULES]),
      ssotPath: null,
      conflicts: Object.freeze([]),
      warnings: Object.freeze([]),
      errors: Object.freeze([`Repository root does not exist: ${repositoryRoot}`]),
    };
  }

  const errors = [];
  const warnings = [];
  const conflicts = [];
  const rules = [...UNIVERSAL_RULES];

  let resolvedSsotPath = null;

  if (options.ssotPath) {
    const explicitPath = path.isAbsolute(options.ssotPath)
      ? options.ssotPath
      : path.resolve(repositoryRoot, options.ssotPath);

    if (fs.existsSync(explicitPath)) {
      resolvedSsotPath = explicitPath;
    } else {
      errors.push(`Explicitly specified SSOT file does not exist: ${explicitPath}`);
    }
  } else {
    // Attempt standard discovery
    for (const candidate of DEFAULT_SSOT_CANDIDATES) {
      const candidatePath = path.resolve(repositoryRoot, candidate);
      if (fs.existsSync(candidatePath)) {
        resolvedSsotPath = candidatePath;
        break;
      }
    }
    if (!resolvedSsotPath) {
      if (requireSsot) {
        errors.push(`Required project SSOT was not found in repository: ${repositoryRoot}`);
      } else {
        warnings.push(`No project SSOT discovered in ${repositoryRoot}. Operating with universal rules only.`);
      }
    }
  }

  // Parse project rules if SSOT file resolved
  if (resolvedSsotPath) {
    try {
      const rawContent = fs.readFileSync(resolvedSsotPath, 'utf8');
      const parsed = JSON.parse(rawContent);

      let candidateRules = [];
      if (Array.isArray(parsed)) {
        candidateRules = parsed;
      } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.rules)) {
        candidateRules = parsed.rules;
      } else {
        errors.push(`SSOT file at ${resolvedSsotPath} must export a JSON array or an object with a 'rules' array.`);
      }

      for (let i = 0; i < candidateRules.length; i++) {
        const rawRule = candidateRules[i];
        const validation = validateRule(rawRule);
        if (!validation.valid) {
          errors.push(`Project rule at index ${i} in ${resolvedSsotPath} is invalid: ${validation.errors.join('; ')}`);
          continue;
        }

        // Check for conflicts with existing rules (universal or already added project rules)
        const existingIndex = rules.findIndex((r) => r.id === rawRule.id);
        if (existingIndex !== -1) {
          const existingRule = rules[existingIndex];
          if (areRulesConflicting(existingRule, rawRule)) {
            conflicts.push({
              id: rawRule.id,
              message: `Conflicting rule definitions detected for '${rawRule.id}' between ${existingRule.source} and ${rawRule.source}.`,
              rules: [existingRule, rawRule],
            });
          }
          // Do not append conflicting or duplicate rule
        } else {
          rules.push(Object.freeze({ ...rawRule }));
        }
      }
    } catch (err) {
      errors.push(`Failed to read or parse SSOT file at ${resolvedSsotPath}: ${err.message}`);
    }
  }

  const success = errors.length === 0 && conflicts.length === 0;

  return {
    success,
    rules: Object.freeze(rules),
    ssotPath: resolvedSsotPath,
    conflicts: Object.freeze(conflicts),
    warnings: Object.freeze(warnings),
    errors: Object.freeze(errors),
  };
}
