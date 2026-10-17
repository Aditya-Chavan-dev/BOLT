import fs from 'node:fs';
import path from 'node:path';
import { SEVERITIES, FINDING_STATUSES } from './severities.mjs';
import { validateFinding } from './finding-schema.mjs';
import { UNIVERSAL_RULES } from './universal-rules.mjs';

const INSUFFICIENT_EVIDENCE_PATTERNS = [
  /^ai says this is bad$/i,
  /^ai says/i,
  /^model confidence/i,
  /^n\/a$/i,
  /^unknown$/i,
  /^unspecified$/i,
];

function isGenericEvidence(evidence) {
  if (typeof evidence === 'string') {
    const trimmed = evidence.trim();
    if (trimmed.length === 0) return true;
    return INSUFFICIENT_EVIDENCE_PATTERNS.some((p) => p.test(trimmed));
  }
  if (evidence && typeof evidence === 'object') {
    const excerpt = typeof evidence.excerpt === 'string' ? evidence.excerpt.trim() : '';
    const output = typeof evidence.output === 'string' ? evidence.output.trim() : '';
    if (!excerpt && !output) return true;
    if (excerpt && INSUFFICIENT_EVIDENCE_PATTERNS.some((p) => p.test(excerpt))) return true;
    if (output && INSUFFICIENT_EVIDENCE_PATTERNS.some((p) => p.test(output))) return true;
  }
  return false;
}

const SEARCH_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.jsx',
  '.tsx',
  '.vue',
  '.svelte',
  '.json',
]);

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
]);

const IGNORED_FILES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
]);

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val !== null && typeof val === 'object') {
      deepFreeze(val);
    }
  }
  return obj;
}

function normalizeSnippet(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');
}

function findSourceFiles(dir, fileList = []) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          findSourceFiles(path.join(dir, entry.name), fileList);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (SEARCH_EXTENSIONS.has(ext)) {
          fileList.push(path.join(dir, entry.name));
        }
      }
    }
  } catch {
    // Gracefully handle unreadable directories
  }
  return fileList;
}

function isPackageReferencedInCodebase(packageName, repositoryRoot) {
  const sourceFiles = findSourceFiles(repositoryRoot);
  const escapedPkg = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const refRegex = new RegExp(
    `(?:(?:from\\s+|import\\s*\\(\\s*|require\\s*\\(\\s*)['"]${escapedPkg}(?:/[^'"]*)?['"]|['"]${escapedPkg}['"])`,
    'm'
  );

  for (const file of sourceFiles) {
    const basename = path.basename(file);
    if (IGNORED_FILES.has(basename)) continue;
    try {
      const content = fs.readFileSync(file, 'utf8');
      if (refRegex.test(content)) {
        return { referenced: true, file };
      }
    } catch {
      // skip unreadable
    }
  }
  return { referenced: false, file: null };
}

/**
 * Validates and challenges a finding candidate against repository context per Section 8 of BLOAT_CHECKER_V1_BUILD_SPEC.md.
 *
 * Checks performed:
 * 1. Structural schema compliance via validateFinding().
 * 2. Location validation: verifies cited file and line range exist in reviewed revision.
 * 3. Rule validation: verifies cited rule exists in active rule set and is not contradicted.
 * 4. Evidence validation: rejects generic model assertions ("AI says this is bad").
 * 5. False-positive challenge: inspects context (e.g. confirms package is genuinely in production
 *    dependencies and has zero references across codebase for RULE-NO-UNNECESSARY-DEPENDENCIES).
 * 6. Downgrades or marks verification-incomplete when evidence is lacking or validation fails.
 *
 * @param {object} finding - Finding object to validate.
 * @param {object} [context]
 * @param {string} [context.repositoryRoot] - Repository root directory.
 * @param {ReadonlyArray<object>} [context.rules] - Active rules set from loadRules().
 * @param {ReadonlyArray<object>} [context.ruleConflicts] - Rule conflicts discovered during loading.
 * @returns {object} Deeply frozen validation result.
 */
export function validateFindingEvidence(finding, context = {}) {
  const repositoryRoot = context.repositoryRoot ? path.resolve(context.repositoryRoot) : process.cwd();
  const rules = Array.isArray(context.rules) && context.rules.length > 0 ? context.rules : UNIVERSAL_RULES;
  const ruleConflicts = Array.isArray(context.ruleConflicts) ? context.ruleConflicts : [];

  // Step 0: Structural Schema Validation
  const structuralCheck = validateFinding(finding);
  if (!structuralCheck.valid) {
    return Object.freeze({
      valid: false,
      status: FINDING_STATUSES.VERIFICATION_INCOMPLETE,
      challengePassed: false,
      rejectionReason: `Finding failed structural schema validation: ${structuralCheck.errors.join('; ')}`,
      finding: null,
      errors: Object.freeze([...structuralCheck.errors]),
    });
  }

  const errors = [];
  let status = finding.status;
  let challengePassed = true;
  let rejectionReason = null;

  // Step 1: Location & Line Verification (Section 8.1)
  const relPath = finding.location.filePath;
  const resolvedRepo = path.resolve(repositoryRoot);
  const fullPath = path.resolve(resolvedRepo, relPath);

  // Check path containment: target must reside within resolvedRepo
  const relCheck = path.relative(resolvedRepo, fullPath);
  const isEscaping = relCheck.startsWith('..') || path.isAbsolute(relCheck);

  if (isEscaping) {
    challengePassed = false;
    status = FINDING_STATUSES.VERIFICATION_INCOMPLETE;
    rejectionReason = `Cited file path '${relPath}' escapes the repository root. External file citations are invalid.`;
    errors.push(rejectionReason);
  } else if (!fs.existsSync(fullPath)) {
    challengePassed = false;
    status = FINDING_STATUSES.VERIFICATION_INCOMPLETE;
    rejectionReason = `Cited file '${relPath}' does not exist in the reviewed revision.`;
    errors.push(rejectionReason);
  } else {
    // Check symlink containment where supported
    let realFullPath = fullPath;
    let realRepo = resolvedRepo;
    let symlinkEscapes = false;
    try {
      realFullPath = fs.realpathSync(fullPath);
      realRepo = fs.realpathSync(resolvedRepo);
      const relRealCheck = path.relative(realRepo, realFullPath);
      if (relRealCheck.startsWith('..') || path.isAbsolute(relRealCheck)) {
        symlinkEscapes = true;
      }
    } catch {
      symlinkEscapes = true;
    }

    if (symlinkEscapes) {
      challengePassed = false;
      status = FINDING_STATUSES.VERIFICATION_INCOMPLETE;
      rejectionReason = `Cited file path '${relPath}' resolves outside repository root via symlink.`;
      errors.push(rejectionReason);
    } else {
      // Read file and verify line citations and evidence content
      try {
        const fileContent = fs.readFileSync(fullPath, 'utf8');
        const lines = fileContent.split(/\r?\n/);
        const totalLines = lines.length;

        if (finding.location.lineRange && typeof finding.location.lineRange === 'object') {
          const { start, end } = finding.location.lineRange;

          if (start > totalLines) {
            challengePassed = false;
            status = FINDING_STATUSES.VERIFICATION_INCOMPLETE;
            rejectionReason = `Cited start line (${start}) exceeds total line count (${totalLines}) in '${relPath}'. Stale or invalid line reference.`;
            errors.push(rejectionReason);
          } else if (end > totalLines) {
            challengePassed = false;
            status = FINDING_STATUSES.VERIFICATION_INCOMPLETE;
            rejectionReason = `Cited end line (${end}) exceeds total line count (${totalLines}) in '${relPath}'. Stale or invalid line reference.`;
            errors.push(rejectionReason);
          } else {
            // Substantive evidence excerpt verification against actual lines
            const citedLines = lines.slice(start - 1, end).join('\n');
            const excerpt =
              typeof finding.evidence === 'string'
                ? finding.evidence.trim()
                : (finding.evidence && typeof finding.evidence.excerpt === 'string')
                  ? finding.evidence.excerpt.trim()
                  : null;

            if (excerpt && !isGenericEvidence(excerpt)) {
              const normCited = normalizeSnippet(citedLines);
              const normExcerpt = normalizeSnippet(excerpt);
              const matchesCited = normCited.includes(normExcerpt) || normExcerpt.includes(normCited);

              if (!matchesCited) {
                challengePassed = false;
                status = FINDING_STATUSES.VERIFICATION_INCOMPLETE;
                rejectionReason = `Cited evidence excerpt does not match actual file contents at lines ${start}-${end} in '${relPath}'. Stale or fabricated citation.`;
                errors.push(rejectionReason);
              }
            }
          }
        } else {
          // No line range given: if excerpt provided, verify it exists anywhere in the file
          const excerpt =
            typeof finding.evidence === 'string'
              ? finding.evidence.trim()
              : (finding.evidence && typeof finding.evidence.excerpt === 'string')
                ? finding.evidence.excerpt.trim()
                : null;

          if (excerpt && !isGenericEvidence(excerpt)) {
            const normContent = normalizeSnippet(fileContent);
            const normExcerpt = normalizeSnippet(excerpt);
            if (!normContent.includes(normExcerpt)) {
              challengePassed = false;
              status = FINDING_STATUSES.VERIFICATION_INCOMPLETE;
              rejectionReason = `Cited evidence excerpt was not found in '${relPath}'. Stale or fabricated citation.`;
              errors.push(rejectionReason);
            }
          }
        }
      } catch (err) {
        challengePassed = false;
        status = FINDING_STATUSES.VERIFICATION_INCOMPLETE;
        rejectionReason = `Could not read cited file '${relPath}' to verify citations: ${err.message}`;
        errors.push(rejectionReason);
      }
    }
  }

  // Step 2: Rule Verification & Conflict Check (Section 8.2)
  if (challengePassed) {
    const isNewRule = Boolean(finding.rule && finding.rule.isNewRule);
    const ruleId = finding.rule ? finding.rule.id : null;

    if (!isNewRule && ruleId) {
      const matchingRule = rules.find((r) => r.id === ruleId);
      if (!matchingRule) {
        challengePassed = false;
        status = FINDING_STATUSES.UNVERIFIED;
        rejectionReason = `Cited rule '${ruleId}' is not defined in the active project SSOT or universal rules.`;
        errors.push(rejectionReason);
      } else {
        // Check for conflicting rules affecting this finding
        const hasConflict = ruleConflicts.some((c) => c.ruleId === ruleId);
        if (hasConflict) {
          challengePassed = false;
          status = FINDING_STATUSES.VERIFICATION_INCOMPLETE;
          rejectionReason = `Cited rule '${ruleId}' is subject to an unresolved rule conflict.`;
          errors.push(rejectionReason);
        }
      }
    }
  }

  // Step 3: Evidence Verification (Section 7 & 8.3)
  if (challengePassed) {
    if (isGenericEvidence(finding.evidence)) {
      challengePassed = false;
      status = FINDING_STATUSES.UNVERIFIED;
      rejectionReason = 'Evidence is generic or unsubstantiated; model assertion alone is never sufficient evidence per Section 7.';
      errors.push(rejectionReason);
    }
  }

  // Step 4 & 5: False-Positive Challenge & Context Inspection (Section 8.4 & 8.6)
  if (challengePassed) {
    const ruleId = finding.rule ? finding.rule.id : '';

    if (ruleId === 'RULE-NO-UNNECESSARY-DEPENDENCIES') {
      // Check package.json context: package must be in production dependencies
      const pkgPath = path.resolve(repositoryRoot, 'package.json');
      if (!fs.existsSync(pkgPath)) {
        challengePassed = false;
        status = FINDING_STATUSES.VERIFICATION_INCOMPLETE;
        rejectionReason = "File 'package.json' does not exist in repository root to verify production dependencies.";
        errors.push(rejectionReason);
      } else {
        try {
          const pkgData = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          const prodDeps = (pkgData && typeof pkgData.dependencies === 'object' && pkgData.dependencies) || {};

          const evidenceStr =
            typeof finding.evidence === 'string'
              ? finding.evidence.trim()
              : (finding.evidence && typeof finding.evidence.excerpt === 'string')
                ? finding.evidence.excerpt.trim()
                : '';

          const depMatch =
            (evidenceStr && evidenceStr.match(/["'](@?[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?)["']:\s*["'][^"']+["']/)) ||
            (evidenceStr && evidenceStr.match(/^["'](@?[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?)["']:/)) ||
            (finding.title && finding.title.match(/[:\s](@?[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?)$/)) ||
            (finding.details && finding.details.match(/Package ['"](@?[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?)['"]/));

          const pkgName = depMatch ? depMatch[1] : null;

          if (!pkgName) {
            challengePassed = false;
            status = FINDING_STATUSES.UNVERIFIED;
            rejectionReason = 'Could not identify declared package name from evidence or title to substantiate dependency violation.';
            errors.push(rejectionReason);
          } else if (!Object.prototype.hasOwnProperty.call(prodDeps, pkgName)) {
            // If package is not in production dependencies (e.g. devDependency or missing) -> false positive
            challengePassed = false;
            status = FINDING_STATUSES.UNVERIFIED;
            rejectionReason = `False positive: Package '${pkgName}' is not declared in production 'dependencies'.`;
            errors.push(rejectionReason);
          } else {
            // Challenge against codebase usage references
            const usage = isPackageReferencedInCodebase(pkgName, repositoryRoot);
            if (usage.referenced) {
              challengePassed = false;
              status = FINDING_STATUSES.UNVERIFIED;
              rejectionReason = `False positive: Package '${pkgName}' is referenced in '${path.relative(repositoryRoot, usage.file)}'.`;
              errors.push(rejectionReason);
            }
          }
        } catch (err) {
          challengePassed = false;
          status = FINDING_STATUSES.VERIFICATION_INCOMPLETE;
          rejectionReason = `Failed to parse package.json during false-positive challenge: ${err.message}`;
          errors.push(rejectionReason);
        }
      }
    }
  }

  // Step 6: Derive updated blocking decision based on verified status
  const isNewRule = Boolean(finding.rule && finding.rule.isNewRule);
  const blocksWorkflow =
    challengePassed &&
    !isNewRule &&
    status === FINDING_STATUSES.VERIFIED &&
    (finding.severity === SEVERITIES.CRITICAL || finding.severity === SEVERITIES.MAJOR);

  const blockReason = blocksWorkflow
    ? `Verified ${finding.severity} violation blocks protected workflow per V1 policy.`
    : rejectionReason ||
      `Finding is non-blocking (status: '${status}', severity: '${finding.severity}').`;

  const updatedValidation = Object.freeze({
    performed: `${finding.validation ? finding.validation.performed : 'Deterministic analyzer inspection'}; Contextual evidence verification and false-positive challenge`,
    result: challengePassed
      ? 'Substantive evidence and contextual challenge confirmed'
      : `Challenge failed or downgraded: ${rejectionReason}`,
  });

  const updatedFinding = Object.freeze({
    ...finding,
    status,
    blocksWorkflow,
    blockReason,
    validation: updatedValidation,
  });

  return deepFreeze({
    valid: challengePassed && status === FINDING_STATUSES.VERIFIED,
    status,
    challengePassed,
    rejectionReason,
    finding: updatedFinding,
    errors: Object.freeze(errors),
  });
}
