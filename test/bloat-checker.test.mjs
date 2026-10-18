import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { EXIT_CODES } from '../src/constants.mjs';
import { SEVERITIES, FINDING_STATUSES } from '../src/severities.mjs';
import { validateFinding } from '../src/finding-schema.mjs';
import { UNIVERSAL_RULES } from '../src/universal-rules.mjs';
import { checkUnusedDependencies } from '../src/checks/unused-dependencies.mjs';
import { generateFinding } from '../src/finding-generator.mjs';
import { validateFindingEvidence } from '../src/finding-validator.mjs';
import { runGate } from '../src/gate-runner.mjs';
import { readGitDiff } from '../src/git-diff.mjs';
import {
  formatHumanReport,
  formatJsonReport,
  sortFindingsDeterministically,
  classifyCheckState,
  computeReportStats,
  SCHEMA_VERSION,
} from '../src/report-formatter.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixtureDir = path.resolve(__dirname, '.temp-fixture');

function setupFixture() {
  cleanupFixture();
  fs.mkdirSync(fixtureDir, { recursive: true });

  const pkgJson = {
    name: 'test-app',
    version: '1.0.0',
    dependencies: {
      'unused-lib': '^1.0.0',
      'used-lib': '^2.0.0',
    },
    devDependencies: {
      'dev-pkg': '^1.0.0',
    },
  };
  fs.writeFileSync(path.join(fixtureDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

  const lockfile = {
    name: 'test-app',
    lockfileVersion: 2,
    packages: {
      'node_modules/unused-lib': { version: '1.0.0' },
      'node_modules/used-lib': { version: '2.0.0' },
    },
  };
  fs.writeFileSync(path.join(fixtureDir, 'package-lock.json'), JSON.stringify(lockfile, null, 2));

  fs.mkdirSync(path.join(fixtureDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, 'src/index.js'),
    `import { helper } from 'used-lib';\nconst answer = 42;\nexport { answer };\n`
  );
}

function cleanupFixture() {
  if (fs.existsSync(fixtureDir)) {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

// Clean diff result mock for isolated gate evaluation
const mockCleanDiff = Object.freeze({
  success: true,
  base: 'HEAD~1',
  current: 'HEAD',
  staged: false,
  changedFiles: Object.freeze([]),
  files: Object.freeze([]),
  untrackedFiles: Object.freeze([]),
  warnings: Object.freeze([]),
  errors: Object.freeze([]),
});

function createBaseFinding(overrides = {}) {
  return {
    id: 'FINDING-RULE-NO-UNNECESSARY-DEPENDENCIES-package-json-5',
    category: 'unnecessary-complexity',
    severity: SEVERITIES.CRITICAL,
    status: FINDING_STATUSES.VERIFIED,
    title: 'Unused production dependency: unused-lib',
    explanation: 'Package unused-lib was declared without references.',
    location: {
      filePath: 'package.json',
      lineRange: { start: 5, end: 5 },
    },
    evidence: '"unused-lib": "^1.0.0"',
    rule: {
      id: 'RULE-NO-UNNECESSARY-DEPENDENCIES',
      source: 'universal',
    },
    impact: 'Adds unneeded dependency bloat.',
    validation: {
      performed: 'Static import scanner',
      result: 'No references found',
    },
    nextAction: 'Remove unused-lib from package.json',
    blocksWorkflow: true,
    blockReason: 'Verified critical violation blocks protected workflow per V1 policy.',
    ...overrides,
  };
}

describe('Bloat Checker Behavioral Test Suite', () => {
  before(() => {
    setupFixture();
  });

  after(() => {
    cleanupFixture();
  });

  // 1. Finding schema validation
  describe('1. Finding Schema Validation', () => {
    it('validates a schema-compliant finding successfully', () => {
      const finding = createBaseFinding();
      const res = validateFinding(finding);
      assert.equal(res.valid, true);
      assert.equal(res.errors.length, 0);
    });

    it('rejects a finding missing required structural fields', () => {
      const invalidFinding = { id: 'PARTIAL-FINDING' };
      const res = validateFinding(invalidFinding);
      assert.equal(res.valid, false);
      assert.ok(res.errors.length > 0);
    });

    it('rejects invalid severity values', () => {
      const finding = createBaseFinding({ severity: 'catastrophic' });
      const res = validateFinding(finding);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('severity')));
    });

    it('rejects invalid status values', () => {
      const finding = createBaseFinding({ status: 'assumed-guilty' });
      const res = validateFinding(finding);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('status')));
    });

    it('requires statement for new proposed rules', () => {
      const finding = createBaseFinding({
        rule: { id: 'NEW-RULE', source: 'discovered', isNewRule: true },
      });
      const res = validateFinding(finding);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('rule.statement')));
    });
  });

  // 2. Evidence excerpt matching and fabricated evidence rejection
  describe('2. Evidence Excerpt Matching and Fabricated Evidence Rejection', () => {
    it('accepts evidence excerpt matching actual file content at cited lines', () => {
      const finding = createBaseFinding({
        location: { filePath: 'package.json', lineRange: { start: 5, end: 5 } },
        evidence: '"unused-lib": "^1.0.0"',
      });
      const res = validateFindingEvidence(finding, { repositoryRoot: fixtureDir });
      assert.equal(res.challengePassed, true);
      assert.equal(res.valid, true);
      assert.equal(res.status, FINDING_STATUSES.VERIFIED);
    });

    it('fails closed when evidence excerpt is fabricated and does not match cited lines', () => {
      const finding = createBaseFinding({
        location: { filePath: 'package.json', lineRange: { start: 5, end: 5 } },
        evidence: '"fabricated-pkg": "^9.9.9"',
      });
      const res = validateFindingEvidence(finding, { repositoryRoot: fixtureDir });
      assert.equal(res.valid, false);
      assert.equal(res.status, FINDING_STATUSES.VERIFICATION_INCOMPLETE);
      assert.equal(res.challengePassed, false);
      assert.ok(res.rejectionReason.includes('does not match actual file contents'));
    });

    it('fails closed when cited start/end lines exceed total lines in file', () => {
      const finding = createBaseFinding({
        location: { filePath: 'package.json', lineRange: { start: 999, end: 999 } },
      });
      const res = validateFindingEvidence(finding, { repositoryRoot: fixtureDir });
      assert.equal(res.valid, false);
      assert.equal(res.status, FINDING_STATUSES.VERIFICATION_INCOMPLETE);
      assert.ok(res.rejectionReason.includes('exceeds total line count'));
    });

    it('downgrades generic AI assertion phrases to unverified', () => {
      const finding = createBaseFinding({
        location: { filePath: 'package.json', lineRange: { start: 5, end: 5 } },
        evidence: 'AI says this is bad',
      });
      const res = validateFindingEvidence(finding, { repositoryRoot: fixtureDir });
      assert.equal(res.valid, false);
      assert.equal(res.status, FINDING_STATUSES.UNVERIFIED);
      assert.equal(res.challengePassed, false);
      assert.ok(res.rejectionReason.includes('generic or unsubstantiated'));
    });

    it('downgrades generic N/A evidence to unverified', () => {
      const finding = createBaseFinding({
        location: { filePath: 'package.json', lineRange: { start: 5, end: 5 } },
        evidence: 'N/A',
      });
      const res = validateFindingEvidence(finding, { repositoryRoot: fixtureDir });
      assert.equal(res.valid, false);
      assert.equal(res.status, FINDING_STATUSES.UNVERIFIED);
      assert.equal(res.challengePassed, false);
    });
  });

  // 3. Repository path traversal and symlink escape rejection
  describe('3. Repository Path Traversal and Symlink Escape Rejection', () => {
    it('rejects relative path traversal escaping repository root via ..', () => {
      const finding = createBaseFinding({
        location: { filePath: '../outside.txt', lineRange: { start: 1, end: 1 } },
      });
      const res = validateFindingEvidence(finding, { repositoryRoot: fixtureDir });
      assert.equal(res.valid, false);
      assert.equal(res.status, FINDING_STATUSES.VERIFICATION_INCOMPLETE);
      assert.ok(res.rejectionReason.includes('escapes the repository root'));
    });

    it('rejects absolute paths outside repository root', () => {
      const outsidePath = path.resolve(__dirname, 'temp-external-probe.txt');
      fs.writeFileSync(outsidePath, 'probe\n');
      try {
        const finding = createBaseFinding({
          location: { filePath: outsidePath, lineRange: { start: 1, end: 1 } },
        });
        const res = validateFindingEvidence(finding, { repositoryRoot: fixtureDir });
        assert.equal(res.valid, false);
        assert.equal(res.status, FINDING_STATUSES.VERIFICATION_INCOMPLETE);
        assert.ok(res.rejectionReason.includes('escapes the repository root'));
      } finally {
        if (fs.existsSync(outsidePath)) fs.rmSync(outsidePath, { force: true });
      }
    });

    it('fails closed when cited file does not exist', () => {
      const finding = createBaseFinding({
        location: { filePath: 'src/missing-file.js', lineRange: { start: 1, end: 1 } },
      });
      const res = validateFindingEvidence(finding, { repositoryRoot: fixtureDir });
      assert.equal(res.valid, false);
      assert.equal(res.status, FINDING_STATUSES.VERIFICATION_INCOMPLETE);
      assert.ok(res.rejectionReason.includes('does not exist in the reviewed revision'));
    });

    it('fails closed when cited file resolves outside repository via symlink', (t) => {
      const outsideTarget = path.resolve(__dirname, 'temp-outside-symlink-target.txt');
      const insideSymlink = path.join(fixtureDir, 'symlink-to-outside.txt');
      fs.writeFileSync(outsideTarget, 'outside secret data\n');
      try {
        fs.symlinkSync(outsideTarget, insideSymlink, 'file');
      } catch (err) {
        if (fs.existsSync(outsideTarget)) fs.rmSync(outsideTarget, { force: true });
        t.skip(`Filesystem symlink creation prohibited on host platform without elevated privileges: ${err.code}`);
        return;
      }

      try {
        const finding = createBaseFinding({
          location: { filePath: 'symlink-to-outside.txt', lineRange: { start: 1, end: 1 } },
        });
        const res = validateFindingEvidence(finding, { repositoryRoot: fixtureDir });
        assert.equal(res.valid, false);
        assert.equal(res.status, FINDING_STATUSES.VERIFICATION_INCOMPLETE);
        assert.ok(res.rejectionReason.includes('symlink'));
      } finally {
        if (fs.existsSync(insideSymlink)) fs.unlinkSync(insideSymlink);
        if (fs.existsSync(outsideTarget)) fs.rmSync(outsideTarget, { force: true });
      }
    });
  });

  // 4. Rule existence and rule-conflict handling
  describe('4. Rule Existence and Rule-Conflict Handling', () => {
    it('downgrades to unverified when cited rule is not in SSOT or universal rules', () => {
      const finding = createBaseFinding({
        location: { filePath: 'package.json', lineRange: { start: 5, end: 5 } },
        rule: { id: 'RULE-UNREGISTERED-CUSTOM', source: 'custom' },
      });
      const res = validateFindingEvidence(finding, { repositoryRoot: fixtureDir });
      assert.equal(res.valid, false);
      assert.equal(res.status, FINDING_STATUSES.UNVERIFIED);
      assert.ok(res.rejectionReason.includes('is not defined in the active project SSOT'));
    });

    it('fails closed with verification-incomplete when cited rule has an active conflict', () => {
      const finding = createBaseFinding({
        location: { filePath: 'package.json', lineRange: { start: 5, end: 5 } },
      });
      const res = validateFindingEvidence(finding, {
        repositoryRoot: fixtureDir,
        ruleConflicts: [{ ruleId: 'RULE-NO-UNNECESSARY-DEPENDENCIES', reason: 'Conflicting rule detected' }],
      });
      assert.equal(res.valid, false);
      assert.equal(res.status, FINDING_STATUSES.VERIFICATION_INCOMPLETE);
      assert.ok(res.rejectionReason.includes('subject to an unresolved rule conflict'));
    });

    it('allows new rule proposals without rule lookup failure', () => {
      const finding = createBaseFinding({
        location: { filePath: 'package.json', lineRange: { start: 5, end: 5 } },
        rule: { id: 'RULE-NEW-IDEA', source: 'discovered', isNewRule: true, statement: 'Proposed rule statement' },
      });
      const res = validateFindingEvidence(finding, { repositoryRoot: fixtureDir });
      assert.equal(res.valid, true);
      assert.equal(res.status, FINDING_STATUSES.VERIFIED);
      assert.equal(res.finding.blocksWorkflow, false);
    });
  });

  // 5. Unverified findings cannot block the gate
  describe('5. Unverified Findings Cannot Block the Gate', () => {
    it('disproves false-positive finding when package is referenced in codebase', async () => {
      const finding = createBaseFinding({
        title: 'Unused production dependency: used-lib',
        location: { filePath: 'package.json', lineRange: { start: 6, end: 6 } },
        evidence: '"used-lib": "^2.0.0"',
      });
      const res = validateFindingEvidence(finding, { repositoryRoot: fixtureDir });
      assert.equal(res.status, FINDING_STATUSES.UNVERIFIED);
      assert.equal(res.finding.blocksWorkflow, false);
      assert.ok(res.rejectionReason.includes('referenced in'));

      const gateRes = await runGate({
        repositoryRoot: fixtureDir,
        diffResult: mockCleanDiff,
        findings: [finding],
        silent: true,
      });
      assert.equal(gateRes.exitCode, EXIT_CODES.SUCCESS);
      assert.equal(gateRes.decision, 'pass');
    });

    it('disproves false-positive finding when package is only in devDependencies', async () => {
      const finding = createBaseFinding({
        title: 'Unused production dependency: dev-pkg',
        location: { filePath: 'package.json', lineRange: { start: 9, end: 9 } },
        evidence: '"dev-pkg": "^1.0.0"',
      });
      const res = validateFindingEvidence(finding, { repositoryRoot: fixtureDir });
      assert.equal(res.status, FINDING_STATUSES.UNVERIFIED);
      assert.equal(res.finding.blocksWorkflow, false);

      const gateRes = await runGate({
        repositoryRoot: fixtureDir,
        diffResult: mockCleanDiff,
        findings: [finding],
        silent: true,
      });
      assert.equal(gateRes.exitCode, EXIT_CODES.SUCCESS);
      assert.equal(gateRes.decision, 'pass');
    });

    it('prevents an unverified finding from blocking the workflow even if blocksWorkflow: true is supplied', async () => {
      const unverifiedWithBlocker = createBaseFinding({
        status: FINDING_STATUSES.UNVERIFIED,
        blocksWorkflow: true,
        blockReason: 'Malicious or unearned blocker flag',
      });

      const gateRes = await runGate({
        repositoryRoot: fixtureDir,
        diffResult: mockCleanDiff,
        findings: [unverifiedWithBlocker],
        silent: true,
      });

      assert.equal(gateRes.exitCode, EXIT_CODES.SUCCESS);
      assert.equal(gateRes.decision, 'pass');
      assert.equal(gateRes.findings[0].blocksWorkflow, false);
    });
  });

  // 6. Incomplete verification fails closed
  describe('6. Incomplete Verification Fails Closed', () => {
    it('forces gate exit code 2 when any finding status is verification-incomplete', async () => {
      const finding = createBaseFinding({
        status: FINDING_STATUSES.VERIFICATION_INCOMPLETE,
        blocksWorkflow: false,
      });

      const gateRes = await runGate({
        repositoryRoot: fixtureDir,
        diffResult: mockCleanDiff,
        findings: [finding],
        silent: true,
      });
      assert.equal(gateRes.exitCode, EXIT_CODES.VERIFICATION_FAILURE);
      assert.equal(gateRes.decision, 'incomplete');
    });

    it('forces gate exit code 2 when check crashes or throws', async () => {
      const crashingCheck = {
        name: 'crashing-check',
        fn: () => {
          throw new Error('Unexpected crash in analyzer');
        },
      };

      const gateRes = await runGate({
        repositoryRoot: fixtureDir,
        diffResult: mockCleanDiff,
        checks: [crashingCheck],
        silent: true,
      });
      assert.equal(gateRes.exitCode, EXIT_CODES.VERIFICATION_FAILURE);
      assert.equal(gateRes.decision, 'incomplete');
    });

    it('fails closed with exit code 2 when a finding with fabricated evidence is submitted through runGate', async () => {
      const fabricatedFinding = createBaseFinding({
        location: { filePath: 'package.json', lineRange: { start: 5, end: 5 } },
        evidence: '"totally-fabricated-line": "^9.9.9"',
        blocksWorkflow: true,
      });

      const gateRes = await runGate({
        repositoryRoot: fixtureDir,
        diffResult: mockCleanDiff,
        findings: [fabricatedFinding],
        silent: true,
      });

      assert.equal(gateRes.exitCode, EXIT_CODES.VERIFICATION_FAILURE);
      assert.equal(gateRes.decision, 'incomplete');
      assert.ok(gateRes.errors.some((err) => err.includes('does not match actual file contents')));
    });
  });

  // 7. Verified blocking findings produce the correct exit code
  describe('7. Verified Blocking Findings Produce Exit Code 1', () => {
    it('blocks gate with exit code 1 when genuine verified blocking finding is present', async () => {
      const genuineFinding = createBaseFinding({
        location: { filePath: 'package.json', lineRange: { start: 5, end: 5 } },
        evidence: '"unused-lib": "^1.0.0"',
      });

      const gateRes = await runGate({
        repositoryRoot: fixtureDir,
        diffResult: mockCleanDiff,
        findings: [genuineFinding],
        silent: true,
      });
      assert.equal(gateRes.exitCode, EXIT_CODES.POLICY_FAILURE);
      assert.equal(gateRes.decision, 'blocked');
      assert.equal(gateRes.findings[0].blocksWorkflow, true);
    });

    it('does not block gate for minor severity verified findings', async () => {
      const minorFinding = createBaseFinding({
        location: { filePath: 'package.json', lineRange: { start: 5, end: 5 } },
        severity: SEVERITIES.MINOR,
        blocksWorkflow: false,
      });

      const gateRes = await runGate({
        repositoryRoot: fixtureDir,
        diffResult: mockCleanDiff,
        findings: [minorFinding],
        silent: true,
      });
      assert.equal(gateRes.exitCode, EXIT_CODES.SUCCESS);
      assert.equal(gateRes.decision, 'pass');
      assert.equal(gateRes.findings[0].blocksWorkflow, false);
    });
  });

  // 8. Exit-code precedence
  describe('8. Exit-Code Precedence', () => {
    it('enforces precedence: setup error (3) > verification incomplete (2) > policy failure (1) > success (0)', async () => {
      // Non-existent repo triggers setup error 3
      const setupErrorRes = await runGate({
        repositoryRoot: path.resolve(fixtureDir, 'non-existent-repo-path'),
        silent: true,
      });
      assert.equal(setupErrorRes.exitCode, EXIT_CODES.SETUP_ERROR);
      assert.equal(setupErrorRes.decision, 'error');

      // Incomplete verification (2) takes precedence over blocking finding (1)
      const blockingFinding = createBaseFinding({
        location: { filePath: 'package.json', lineRange: { start: 5, end: 5 } },
      });
      const incompleteFinding = createBaseFinding({
        status: FINDING_STATUSES.VERIFICATION_INCOMPLETE,
        blocksWorkflow: false,
      });

      const precedenceRes = await runGate({
        repositoryRoot: fixtureDir,
        diffResult: mockCleanDiff,
        findings: [blockingFinding, incompleteFinding],
        silent: true,
      });
      assert.equal(precedenceRes.exitCode, EXIT_CODES.VERIFICATION_FAILURE);
      assert.equal(precedenceRes.decision, 'incomplete');
    });
  });

  // 9. Mandatory dependency check cannot be bypassed by custom checks
  describe('9. Mandatory Dependency Check Preservation', () => {
    it('preserves mandatory unused-dependencies check when custom checks are supplied', async () => {
      let customExecuted = false;
      const customCheck = {
        name: 'custom-checker',
        fn: () => {
          customExecuted = true;
          return { executed: true, violations: [], errors: [] };
        },
      };

      const gateRes = await runGate({
        repositoryRoot: fixtureDir,
        diffResult: mockCleanDiff,
        checks: [customCheck],
        silent: true,
      });
      assert.equal(customExecuted, true);
      assert.ok(gateRes.checks.some((c) => c.name === 'unused-dependencies'));
      assert.ok(gateRes.checks.some((c) => c.name === 'custom-checker'));
    });

    it('fails closed when empty checks array is provided to bypass checks', async () => {
      const gateRes = await runGate({
        repositoryRoot: fixtureDir,
        diffResult: mockCleanDiff,
        checks: [],
        silent: true,
      });
      assert.equal(gateRes.exitCode, EXIT_CODES.VERIFICATION_FAILURE);
      assert.equal(gateRes.decision, 'incomplete');
    });

    it('executes real mandatory dependency check even when custom check impersonates its name', async () => {
      const diffWithUnusedDep = {
        success: true,
        base: 'HEAD~1',
        current: 'HEAD',
        staged: false,
        changedFiles: [
          {
            path: 'package.json',
            status: 'M',
            addedLines: [{ line: 5, content: '    "unused-lib": "^1.0.0",' }],
          },
        ],
        files: [],
        untrackedFiles: [],
        warnings: [],
        errors: [],
      };

      let fakeExecuted = false;
      const fakeCheck = {
        name: 'unused-dependencies',
        fn: () => {
          fakeExecuted = true;
          return { executed: true, violations: [], errors: [] };
        },
      };

      const gateRes = await runGate({
        repositoryRoot: fixtureDir,
        diffResult: diffWithUnusedDep,
        checks: [fakeCheck],
        silent: true,
      });

      assert.equal(fakeExecuted, true);
      assert.equal(gateRes.exitCode, EXIT_CODES.POLICY_FAILURE);
      assert.equal(gateRes.decision, 'blocked');
      assert.ok(
        gateRes.findings.some(
          (f) =>
            f.rule.id === 'RULE-NO-UNNECESSARY-DEPENDENCIES' &&
            ((typeof f.evidence === 'string' && f.evidence.includes('unused-lib')) ||
              (typeof f.explanation === 'string' && f.explanation.includes('unused-lib')))
        ),
        'Real mandatory check must detect unused dependency despite impersonation attempt'
      );
    });
  });

  // 10. Regression protection for the existing dependency analyzer
  describe('10. Regression Protection for checkUnusedDependencies', () => {
    it('skips check cleanly when package.json is not modified in diff', () => {
      const diffWithoutPkg = {
        changedFiles: [{ path: 'src/index.js', status: 'M' }],
      };
      const res = checkUnusedDependencies({
        repositoryRoot: fixtureDir,
        diffResult: diffWithoutPkg,
      });
      assert.equal(res.executed, false);
      assert.ok(res.skippedReason.includes('was not modified'));
      assert.equal(res.violations.length, 0);
    });

    it('detects newly added production dependency with zero references', () => {
      const diffWithAddedDep = {
        changedFiles: [
          {
            path: 'package.json',
            status: 'M',
            addedLines: [{ line: 5, content: '    "unused-lib": "^1.0.0",' }],
          },
        ],
      };
      const res = checkUnusedDependencies({
        repositoryRoot: fixtureDir,
        diffResult: diffWithAddedDep,
      });
      assert.equal(res.executed, true);
      assert.equal(res.violations.length, 1);
      assert.equal(res.violations[0].packageName, 'unused-lib');
      assert.equal(res.violations[0].ruleId, 'RULE-NO-UNNECESSARY-DEPENDENCIES');
    });

    it('does not flag newly added dependency if referenced in source code', () => {
      const diffWithUsedDep = {
        changedFiles: [
          {
            path: 'package.json',
            status: 'M',
            addedLines: [{ line: 6, content: '    "used-lib": "^2.0.0"' }],
          },
        ],
      };
      const res = checkUnusedDependencies({
        repositoryRoot: fixtureDir,
        diffResult: diffWithUsedDep,
      });
      assert.equal(res.executed, true);
      assert.equal(res.violations.length, 0);
    });

    it('does not flag dependencies added to devDependencies', () => {
      const diffWithDevDep = {
        changedFiles: [
          {
            path: 'package.json',
            status: 'M',
            addedLines: [{ line: 9, content: '    "dev-pkg": "^1.0.0"' }],
          },
        ],
      };
      const res = checkUnusedDependencies({
        repositoryRoot: fixtureDir,
        diffResult: diffWithDevDep,
      });
      assert.equal(res.executed, true);
      assert.equal(res.violations.length, 0);
    });

    it('returns deeply frozen result and violations', () => {
      const diffWithAddedDep = {
        changedFiles: [
          {
            path: 'package.json',
            status: 'M',
            addedLines: [{ line: 5, content: '    "unused-lib": "^1.0.0",' }],
          },
        ],
      };
      const res = checkUnusedDependencies({
        repositoryRoot: fixtureDir,
        diffResult: diffWithAddedDep,
      });
      assert.ok(Object.isFrozen(res));
      assert.ok(Object.isFrozen(res.violations));
      assert.ok(Object.isFrozen(res.violations[0]));
    });
  });

  // 11. Unit 13 — Structured Report Formatting and Output
  describe('11. Unit 13 — Structured Report Formatting and Output', () => {
    it('sorts findings deterministically using full tie-breaker hierarchy', () => {
      const f1 = createBaseFinding({
        id: 'FINDING-B',
        title: 'B Title',
        location: { filePath: 'src/b.js', lineRange: { start: 10, end: 12 } },
        rule: { id: 'RULE-1' },
      });
      const f2 = createBaseFinding({
        id: 'FINDING-A-LINE-5',
        title: 'A Title Line 5',
        location: { filePath: 'src/a.js', lineRange: { start: 5, end: 5 } },
        rule: { id: 'RULE-1' },
      });
      const f3 = createBaseFinding({
        id: 'FINDING-A-LINE-10',
        title: 'A Title Line 10',
        location: { filePath: 'src/a.js', lineRange: { start: 10, end: 15 } },
        rule: { id: 'RULE-1' },
      });
      const f4 = createBaseFinding({
        id: 'FINDING-A-LINE-10-RULE-2',
        title: 'A Title Line 10 Rule 2',
        location: { filePath: 'src/a.js', lineRange: { start: 10, end: 15 } },
        rule: { id: 'RULE-2' },
      });
      const f5 = createBaseFinding({
        id: 'FINDING-A-LINE-10-RULE-2-TIE-1',
        title: 'Alpha Title',
        location: { filePath: 'src/a.js', lineRange: { start: 10, end: 15 } },
        rule: { id: 'RULE-2' },
        evidence: 'const x = 1;',
      });
      const f6 = createBaseFinding({
        id: 'FINDING-A-LINE-10-RULE-2-TIE-2',
        title: 'Beta Title',
        location: { filePath: 'src/a.js', lineRange: { start: 10, end: 15 } },
        rule: { id: 'RULE-2' },
        evidence: 'const y = 2;',
      });

      const sorted = sortFindingsDeterministically([f1, f6, f4, f2, f5, f3]);
      assert.equal(sorted[0].location.filePath, 'src/a.js');
      assert.equal(sorted[0].location.lineRange.start, 5);
      assert.equal(sorted[1].location.lineRange.start, 10);
      assert.equal(sorted[1].rule.id, 'RULE-1');
      assert.equal(sorted[sorted.length - 1].location.filePath, 'src/b.js');
    });

    it('generates deterministic byte-for-byte JSON output regardless of finding input order', () => {
      const f1 = createBaseFinding({
        id: 'FINDING-1',
        location: { filePath: 'src/first.js', lineRange: { start: 1, end: 1 } },
        title: 'First finding',
      });
      const f2 = createBaseFinding({
        id: 'FINDING-2',
        location: { filePath: 'src/second.js', lineRange: { start: 20, end: 20 } },
        title: 'Second finding',
      });

      const runDataA = {
        decision: 'blocked',
        exitCode: EXIT_CODES.POLICY_FAILURE,
        summary: 'Gate blocked: 2 verified blocking violation(s) detected.',
        diff: mockCleanDiff,
        rules: UNIVERSAL_RULES,
        findings: [f1, f2],
        checks: [
          { name: 'check-b', executed: true, violations: [f2], errors: [] },
          { name: 'check-a', executed: true, violations: [f1], errors: [] },
        ],
        warnings: [],
        errors: [],
      };

      const runDataB = {
        ...runDataA,
        findings: [f2, f1],
        checks: [
          { name: 'check-a', executed: true, violations: [f1], errors: [] },
          { name: 'check-b', executed: true, violations: [f2], errors: [] },
        ],
      };

      const jsonA = formatJsonReport(runDataA);
      const jsonB = formatJsonReport(runDataB);

      assert.equal(jsonA, jsonB, 'JSON report must be byte-for-byte identical regardless of input order');

      const parsed = JSON.parse(jsonA);
      assert.equal(parsed.schemaVersion, SCHEMA_VERSION);
      assert.equal(parsed.decision, 'blocked');
      assert.equal(parsed.exitCode, 1);
      assert.equal(parsed.stats.totalFindings, 2);
      assert.equal(parsed.stats.blockingFindings, 2);
      assert.equal(parsed.stats.checksCompleted, 2);
      assert.equal(parsed.checks[0].name, 'check-a');
      assert.equal(parsed.checks[1].name, 'check-b');
    });

    it('accurately classifies check execution states and never mislabels failures as skips', () => {
      const completedCheck = { name: 'c1', executed: true, skippedReason: null, violations: [], errors: [] };
      const skippedCheck = { name: 'c2', executed: false, skippedReason: 'package.json unmodified', violations: [], errors: [] };
      const failedCheckNoReason = { name: 'c3', executed: false, skippedReason: null, violations: [], errors: [] };
      const crashedCheckWithErrors = { name: 'c4', executed: false, skippedReason: null, violations: [], errors: ['Crash'] };
      const checkWithDiagnosticErrors = { name: 'c5', executed: true, skippedReason: null, violations: [], errors: ['Validation incomplete'] };

      assert.equal(classifyCheckState(completedCheck), 'COMPLETED');
      assert.equal(classifyCheckState(skippedCheck), 'SKIPPED');
      assert.equal(classifyCheckState(failedCheckNoReason), 'FAILED');
      assert.equal(classifyCheckState(crashedCheckWithErrors), 'FAILED');
      assert.equal(classifyCheckState(checkWithDiagnosticErrors), 'FAILED');

      const runData = {
        decision: 'incomplete',
        exitCode: EXIT_CODES.VERIFICATION_FAILURE,
        checks: [completedCheck, skippedCheck, crashedCheckWithErrors],
        findings: [],
      };
      const human = formatHumanReport(runData);
      assert.ok(human.includes('[c1]: COMPLETED'));
      assert.ok(human.includes('[c2]: SKIPPED (package.json unmodified)'));
      assert.ok(human.includes('[c4]: FAILED/INCOMPLETE: Crash'));
      assert.ok(!human.includes('[c4]: SKIPPED'), 'Crashed check must never be reported as SKIPPED');
    });

    it('faithfully represents all four gate decisions and exit codes in human and JSON outputs', () => {
      const cases = [
        { decision: 'pass', exitCode: EXIT_CODES.SUCCESS },
        { decision: 'blocked', exitCode: EXIT_CODES.POLICY_FAILURE },
        { decision: 'incomplete', exitCode: EXIT_CODES.VERIFICATION_FAILURE },
        { decision: 'error', exitCode: EXIT_CODES.SETUP_ERROR },
      ];

      for (const { decision, exitCode } of cases) {
        const runData = {
          decision,
          exitCode,
          summary: `Gate summary for ${decision}`,
          findings: [],
          checks: [],
        };

        const human = formatHumanReport(runData);
        assert.ok(human.includes(`Decision : ${decision.toUpperCase()} (Exit Code: ${exitCode})`));
        assert.ok(human.includes(`SUMMARY: ${decision.toUpperCase()} — Exit Code ${exitCode}`));

        const jsonStr = formatJsonReport(runData);
        const parsed = JSON.parse(jsonStr);
        assert.equal(parsed.decision, decision);
        assert.equal(parsed.exitCode, exitCode);
      }
    });

    it('preserves evidence fidelity and rejection reasons without mutating finding data', () => {
      const findingWithEvidence = createBaseFinding({
        location: { filePath: 'package.json', lineRange: { start: 5, end: 7 } },
        evidence: '"dep": "^1.0.0"',
        rejectionReason: 'Evidence does not match file contents',
        status: FINDING_STATUSES.VERIFICATION_INCOMPLETE,
        blocksWorkflow: false,
      });

      const initialStatus = findingWithEvidence.status;
      const initialBlocks = findingWithEvidence.blocksWorkflow;

      const runData = {
        decision: 'incomplete',
        exitCode: EXIT_CODES.VERIFICATION_FAILURE,
        findings: [findingWithEvidence],
        checks: [],
      };

      const human = formatHumanReport(runData);
      assert.ok(human.includes('Location          : package.json:5-7'));
      assert.ok(human.includes('Evidence          : "dep": "^1.0.0"'));
      assert.ok(human.includes('Validation Note   : Evidence does not match file contents'));

      const parsed = JSON.parse(formatJsonReport(runData));
      assert.equal(parsed.findings[0].location.filePath, 'package.json');
      assert.equal(parsed.findings[0].location.lineRange.start, 5);
      assert.equal(parsed.findings[0].location.lineRange.end, 7);
      assert.equal(parsed.findings[0].evidence, '"dep": "^1.0.0"');
      assert.equal(parsed.findings[0].rejectionReason, 'Evidence does not match file contents');

      assert.equal(findingWithEvidence.status, initialStatus);
      assert.equal(findingWithEvidence.blocksWorkflow, initialBlocks);
    });

    it('fails closed with exit code 2 when report generation throws during clean gate run', async () => {
      const circularEvidence = { excerpt: 'mock excerpt' };
      circularEvidence.self = circularEvidence;

      const findingWithCircularEvidence = createBaseFinding({
        severity: SEVERITIES.MINOR,
        status: FINDING_STATUSES.UNVERIFIED,
        blocksWorkflow: false,
        evidence: circularEvidence,
      });

      const gateRes = await runGate({
        repositoryRoot: fixtureDir,
        diffResult: mockCleanDiff,
        findings: [findingWithCircularEvidence],
        json: true,
        silent: true,
      });

      assert.equal(gateRes.success, false);
      assert.equal(gateRes.exitCode, EXIT_CODES.VERIFICATION_FAILURE);
      assert.equal(gateRes.decision, 'incomplete');
      assert.ok(gateRes.errors.some((err) => err.includes('Report formatting failed')));
    });

    it('preserves original setup error exit code 3 when report generation throws during setup failure', async () => {
      const circularEvidence = { excerpt: 'mock excerpt' };
      circularEvidence.self = circularEvidence;

      const findingWithCircularEvidence = createBaseFinding({
        severity: SEVERITIES.MINOR,
        status: FINDING_STATUSES.UNVERIFIED,
        blocksWorkflow: false,
        evidence: circularEvidence,
      });

      const gateRes = await runGate({
        repositoryRoot: path.resolve(__dirname, 'non-existent-directory-probe-404'),
        findings: [findingWithCircularEvidence],
        json: true,
        silent: true,
      });

      assert.equal(gateRes.success, false);
      assert.equal(gateRes.exitCode, EXIT_CODES.SETUP_ERROR);
      assert.equal(gateRes.decision, 'error');
      assert.ok(gateRes.errors.some((err) => err.includes('Report formatting failed')));
    });
  });

  // 12. Unit 14 — CI Gate and CLI Enforcement
  describe('12. Unit 14 — CI Gate and CLI Enforcement', () => {
    const ciRepoDir = path.resolve(__dirname, '.temp-ci-repo');
    const gateRunnerPath = path.resolve(__dirname, '../src/gate-runner.mjs');

    function cleanupCiRepo() {
      if (fs.existsSync(ciRepoDir)) {
        fs.rmSync(ciRepoDir, { recursive: true, force: true });
      }
    }

    function initCiRepo() {
      cleanupCiRepo();
      fs.mkdirSync(ciRepoDir, { recursive: true });
      execFileSync('git', ['init', '-b', 'main'], { cwd: ciRepoDir });
      execFileSync('git', ['config', 'user.name', 'CI Test Runner'], { cwd: ciRepoDir });
      execFileSync('git', ['config', 'user.email', 'ci-test@example.com'], { cwd: ciRepoDir });

      const basePkg = {
        name: 'ci-target-app',
        version: '1.0.0',
        dependencies: {
          'used-lib': '^1.0.0',
        },
      };
      fs.writeFileSync(path.join(ciRepoDir, 'package.json'), JSON.stringify(basePkg, null, 2));

      fs.mkdirSync(path.join(ciRepoDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(ciRepoDir, 'src/index.js'),
        "import { helper } from 'used-lib';\nexport const active = true;\n"
      );

      execFileSync('git', ['add', '.'], { cwd: ciRepoDir });
      execFileSync('git', ['commit', '-m', 'Initial baseline commit'], { cwd: ciRepoDir });
    }

    before(() => {
      initCiRepo();
    });

    after(() => {
      cleanupCiRepo();
    });

    it('executes real CLI child process on clean change and passes with exit code 0', () => {
      execFileSync('git', ['checkout', '-b', 'feature-clean'], { cwd: ciRepoDir });
      fs.writeFileSync(path.join(ciRepoDir, 'src/util.js'), 'export const util = 100;\n');
      execFileSync('git', ['add', 'src/util.js'], { cwd: ciRepoDir });
      execFileSync('git', ['commit', '-m', 'Add util file'], { cwd: ciRepoDir });

      const reportJsonPath = path.join(ciRepoDir, 'ci-clean-report.json');

      const stdout = execFileSync(
        process.execPath,
        [gateRunnerPath, '--repo', ciRepoDir, '--base', 'main', '--output-json', reportJsonPath],
        { encoding: 'utf8' }
      );

      assert.ok(stdout.includes('Decision : PASS (Exit Code: 0)'));
      assert.ok(fs.existsSync(reportJsonPath), 'Report JSON file must be created');
      const parsed = JSON.parse(fs.readFileSync(reportJsonPath, 'utf8'));
      assert.equal(parsed.decision, 'pass');
      assert.equal(parsed.exitCode, 0);
      assert.equal(parsed.stats.blockingFindings, 0);
      fs.rmSync(reportJsonPath, { force: true });

      execFileSync('git', ['checkout', 'main'], { cwd: ciRepoDir });
    });

    it('executes real CLI child process on seeded blocking violation and exits with code 1', () => {
      execFileSync('git', ['checkout', '-b', 'feature-bloat-violation'], { cwd: ciRepoDir });
      const bloatPkg = {
        name: 'ci-target-app',
        version: '1.0.0',
        dependencies: {
          'used-lib': '^1.0.0',
          'unused-evil-bloat': '^2.0.0',
        },
      };
      fs.writeFileSync(path.join(ciRepoDir, 'package.json'), JSON.stringify(bloatPkg, null, 2));
      execFileSync('git', ['add', 'package.json'], { cwd: ciRepoDir });
      execFileSync('git', ['commit', '-m', 'Add unused bloat dependency'], { cwd: ciRepoDir });

      const reportJsonPath = path.join(ciRepoDir, 'ci-bloat-report.json');
      let childExitCode = null;
      let childOutput = '';

      try {
        execFileSync(
          process.execPath,
          [gateRunnerPath, '--repo', ciRepoDir, '--base', 'main', '--output-json', reportJsonPath],
          { encoding: 'utf8' }
        );
      } catch (err) {
        childExitCode = err.status;
        childOutput = (err.stdout || '') + (err.stderr || '');
      }

      assert.equal(childExitCode, 1, 'Seeded blocking violation must exit with process exit code 1');
      assert.ok(childOutput.includes('Decision : BLOCKED (Exit Code: 1)'));
      assert.ok(childOutput.includes('unused-evil-bloat'));
      assert.ok(fs.existsSync(reportJsonPath), 'Report JSON file must be written even on block');
      const parsed = JSON.parse(fs.readFileSync(reportJsonPath, 'utf8'));
      assert.equal(parsed.decision, 'blocked');
      assert.equal(parsed.exitCode, 1);
      assert.equal(parsed.stats.blockingFindings, 1);
      fs.rmSync(reportJsonPath, { force: true });

      execFileSync('git', ['checkout', 'main'], { cwd: ciRepoDir });
    });

    it('fails closed with exit code 3 when unresolvable base revision is supplied', () => {
      let childExitCode = null;
      let childOutput = '';

      try {
        execFileSync(
          process.execPath,
          [gateRunnerPath, '--repo', ciRepoDir, '--base', 'non-existent-base-ref'],
          { encoding: 'utf8' }
        );
      } catch (err) {
        childExitCode = err.status;
        childOutput = (err.stdout || '') + (err.stderr || '');
      }

      assert.equal(childExitCode, 3, 'Unresolvable base must exit with process exit code 3');
      assert.ok(childOutput.includes('Decision : ERROR (Exit Code: 3)'));
      assert.ok(childOutput.includes("Cannot resolve base revision 'non-existent-base-ref'"));
    });

    it('fails closed with exit code 2 when incomplete verification occurs in real CLI', () => {
      // Stage an unused dependency addition
      const bloatPkg = {
        name: 'ci-target-app',
        version: '1.0.0',
        dependencies: {
          'used-lib': '^1.0.0',
          'staged-unverified-bloat': '^2.0.0',
        },
      };
      const pkgJsonPath = path.join(ciRepoDir, 'package.json');
      fs.writeFileSync(pkgJsonPath, JSON.stringify(bloatPkg, null, 2));
      execFileSync('git', ['add', 'package.json'], { cwd: ciRepoDir });

      // Shift line in working tree by removing used-lib so cited line does not match working tree
      const shiftedPkg = {
        name: 'ci-target-app',
        dependencies: {
          'staged-unverified-bloat': '^2.0.0',
        },
      };
      fs.writeFileSync(pkgJsonPath, JSON.stringify(shiftedPkg, null, 2));

      let childExitCode = null;
      let childOutput = '';

      try {
        execFileSync(
          process.execPath,
          [gateRunnerPath, '--repo', ciRepoDir, '--staged'],
          { encoding: 'utf8' }
        );
      } catch (err) {
        childExitCode = err.status;
        childOutput = (err.stdout || '') + (err.stderr || '');
      } finally {
        execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: ciRepoDir });
      }

      assert.equal(childExitCode, 2, 'Incomplete verification via excerpt mismatch must exit with code 2');
      assert.ok(childOutput.includes('Decision : INCOMPLETE (Exit Code: 2)'));
      assert.ok(childOutput.includes('does not match actual file contents'));
    });

    it('fails closed with exit code 2 when --output-json cannot be written to invalid path', () => {
      const invalidPath = path.join(ciRepoDir, 'existing-dir-conflict/sub/report.json');
      fs.writeFileSync(path.join(ciRepoDir, 'existing-dir-conflict'), 'not a dir');

      let childExitCode = null;
      let childOutput = '';

      try {
        execFileSync(
          process.execPath,
          [gateRunnerPath, '--repo', ciRepoDir, '--output-json', invalidPath],
          { encoding: 'utf8' }
        );
      } catch (err) {
        childExitCode = err.status;
        childOutput = (err.stdout || '') + (err.stderr || '');
      }

      assert.equal(childExitCode, 2, 'Failed report write must fail closed with exit code 2');
      assert.ok(childOutput.includes('Failed to write JSON report'));
    });
  });

  // 13. Unit 14 Hardening — Containment, Quoted Filenames, and Schema Accuracy
  describe('13. Unit 14 Hardening — Containment, Quoted Filenames, and Schema Accuracy', () => {
    const hardenRepoDir = path.resolve(__dirname, '.temp-harden-repo');

    let baselineCommitHash = '';

    function cleanupHardenRepo() {
      if (fs.existsSync(hardenRepoDir)) {
        fs.rmSync(hardenRepoDir, { recursive: true, force: true });
      }
    }

    function initHardenRepo() {
      cleanupHardenRepo();
      fs.mkdirSync(hardenRepoDir, { recursive: true });
      execFileSync('git', ['init', '-b', 'main'], { cwd: hardenRepoDir });
      execFileSync('git', ['config', 'user.name', 'Hardening Runner'], { cwd: hardenRepoDir });
      execFileSync('git', ['config', 'user.email', 'hardening@example.com'], { cwd: hardenRepoDir });

      const basePkg = {
        name: 'harden-test-app',
        version: '1.0.0',
        dependencies: {
          'used-lib': '^1.0.0',
          'unused-lib': '^1.0.0',
        },
      };
      fs.writeFileSync(path.join(hardenRepoDir, 'package.json'), JSON.stringify(basePkg, null, 2));
      fs.mkdirSync(path.join(hardenRepoDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(hardenRepoDir, 'src/index.js'),
        "import { helper } from 'used-lib';\nexport const ok = true;\n"
      );
      execFileSync('git', ['add', '.'], { cwd: hardenRepoDir });
      execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: hardenRepoDir });
      baselineCommitHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: hardenRepoDir, encoding: 'utf8' }).trim();
    }

    function resetToBaseline() {
      if (baselineCommitHash) {
        execFileSync('git', ['reset', '--hard', baselineCommitHash], { cwd: hardenRepoDir });
        execFileSync('git', ['clean', '-fd'], { cwd: hardenRepoDir });
      }
    }

    before(() => {
      initHardenRepo();
    });

    after(() => {
      cleanupHardenRepo();
    });

    it('fails closed with exit code 2 when --output-json escapes repository root via traversal (../)', async () => {
      const outsideCanary = path.resolve(hardenRepoDir, '../escaped-canary.json');
      fs.writeFileSync(outsideCanary, 'CANARY_ORIGINAL');

      const res = await runGate({
        repositoryRoot: hardenRepoDir,
        outputJson: '../escaped-canary.json',
        silent: true,
      });
      assert.equal(res.success, false);
      assert.equal(res.exitCode, EXIT_CODES.VERIFICATION_FAILURE);
      assert.ok(res.errors.some((e) => e.includes('escapes the repository root')));
      assert.equal(fs.readFileSync(outsideCanary, 'utf8'), 'CANARY_ORIGINAL');

      if (fs.existsSync(outsideCanary)) fs.unlinkSync(outsideCanary);
    });

    it('fails closed with exit code 2 when --output-json specifies absolute path outside repository root', async () => {
      const outsidePath = path.resolve(hardenRepoDir, '../outside-abs-report.json');
      fs.writeFileSync(outsidePath, 'CANARY_ORIGINAL');

      const res = await runGate({
        repositoryRoot: hardenRepoDir,
        outputJson: outsidePath,
        silent: true,
      });
      assert.equal(res.success, false);
      assert.equal(res.exitCode, EXIT_CODES.VERIFICATION_FAILURE);
      assert.ok(res.errors.some((e) => e.includes('escapes the repository root')));
      assert.equal(fs.readFileSync(outsidePath, 'utf8'), 'CANARY_ORIGINAL');

      if (fs.existsSync(outsidePath)) fs.unlinkSync(outsidePath);
    });

    it('fails closed with exit code 2 when --output-json parent directory resolves outside repository via junction/symlink', async () => {
      const outsideTargetDir = path.resolve(hardenRepoDir, '../outside-target-junction');
      fs.mkdirSync(outsideTargetDir, { recursive: true });
      const canaryFile = path.join(outsideTargetDir, 'canary.json');
      fs.writeFileSync(canaryFile, 'CANARY_ORIGINAL');

      const junctionLink = path.join(hardenRepoDir, 'link-outside-dir');
      fs.symlinkSync(outsideTargetDir, junctionLink, 'junction');

      const res = await runGate({
        repositoryRoot: hardenRepoDir,
        outputJson: 'link-outside-dir/nested/escaped-report.json',
        silent: true,
      });

      assert.equal(res.success, false);
      assert.equal(res.exitCode, EXIT_CODES.VERIFICATION_FAILURE);
      assert.ok(res.errors.some((e) => e.includes('resolves outside repository root via symlink')));
      assert.equal(fs.readFileSync(canaryFile, 'utf8'), 'CANARY_ORIGINAL');
      assert.ok(!fs.existsSync(path.join(outsideTargetDir, 'nested/escaped-report.json')));

      if (fs.existsSync(junctionLink)) fs.unlinkSync(junctionLink);
      if (fs.existsSync(outsideTargetDir)) fs.rmSync(outsideTargetDir, { recursive: true, force: true });
    });

    it('fails closed with exit code 2 when --output-json is a symlink resolving outside repository root', async () => {
      const outsideTargetFile = path.resolve(hardenRepoDir, '../outside-victim.json');
      fs.writeFileSync(outsideTargetFile, 'VICTIM_CANARY_ORIGINAL');

      const symlinkInRepo = path.join(hardenRepoDir, 'symlinked-victim.json');
      let linkCreated = false;
      try {
        fs.symlinkSync(outsideTargetFile, symlinkInRepo, 'file');
        linkCreated = true;
      } catch {
        // Creating file symlinks on Windows requires developer mode or elevated privilege
      }

      if (linkCreated) {
        const res = await runGate({
          repositoryRoot: hardenRepoDir,
          outputJson: 'symlinked-victim.json',
          silent: true,
        });

        assert.equal(res.success, false);
        assert.equal(res.exitCode, EXIT_CODES.VERIFICATION_FAILURE);
        assert.ok(res.errors.some((e) => e.includes('resolves outside repository root')));
        assert.equal(fs.readFileSync(outsideTargetFile, 'utf8'), 'VICTIM_CANARY_ORIGINAL');

        if (fs.existsSync(symlinkInRepo)) fs.unlinkSync(symlinkInRepo);
      }
      if (fs.existsSync(outsideTargetFile)) fs.unlinkSync(outsideTargetFile);
    });

    if (process.platform === 'win32') {
      it('fails closed with exit code 2 when --output-json uses Windows reserved device names, variants, or ADS', async () => {
        const devRes = await runGate({
          repositoryRoot: hardenRepoDir,
          outputJson: 'NUL',
          silent: true,
        });
        assert.equal(devRes.success, false);
        assert.equal(devRes.exitCode, EXIT_CODES.VERIFICATION_FAILURE);
        assert.ok(devRes.errors.some((e) => e.includes('reserved Windows device name')));

        const devVariantRes = await runGate({
          repositoryRoot: hardenRepoDir,
          outputJson: 'NUL .txt',
          silent: true,
        });
        assert.equal(devVariantRes.success, false);
        assert.equal(devVariantRes.exitCode, EXIT_CODES.VERIFICATION_FAILURE);
        assert.ok(devVariantRes.errors.some((e) => e.includes('reserved Windows device name')));

        const devDirRes = await runGate({
          repositoryRoot: hardenRepoDir,
          outputJson: 'aux/report.json',
          silent: true,
        });
        assert.equal(devDirRes.success, false);
        assert.equal(devDirRes.exitCode, EXIT_CODES.VERIFICATION_FAILURE);
        assert.ok(devDirRes.errors.some((e) => e.includes('reserved Windows device name')));

        const adsRes = await runGate({
          repositoryRoot: hardenRepoDir,
          outputJson: 'report.json:stream',
          silent: true,
        });
        assert.equal(adsRes.success, false);
        assert.equal(adsRes.exitCode, EXIT_CODES.VERIFICATION_FAILURE);
        assert.ok(adsRes.errors.some((e) => e.includes('invalid alternate data stream syntax')));
      });
    }

    it('succeeds with exit code 0 when --output-json is a valid relative path within repository root', async () => {
      const reportFile = 'valid-report.json';
      const fullReportPath = path.join(hardenRepoDir, reportFile);
      if (fs.existsSync(fullReportPath)) fs.unlinkSync(fullReportPath);

      const res = await runGate({
        repositoryRoot: hardenRepoDir,
        outputJson: reportFile,
        silent: true,
      });
      assert.equal(res.exitCode, EXIT_CODES.SUCCESS);
      assert.ok(fs.existsSync(fullReportPath));
      if (fs.existsSync(fullReportPath)) fs.unlinkSync(fullReportPath);
    });

    it('succeeds with exit code 0 when --output-json is a nested relative path within repository root', async () => {
      const reportRel = 'reports/deep/nested-report.json';
      const fullReportPath = path.join(hardenRepoDir, reportRel);
      if (fs.existsSync(fullReportPath)) fs.unlinkSync(fullReportPath);

      const res = await runGate({
        repositoryRoot: hardenRepoDir,
        outputJson: reportRel,
        silent: true,
      });
      assert.equal(res.exitCode, EXIT_CODES.SUCCESS);
      assert.ok(fs.existsSync(fullReportPath));
      if (fs.existsSync(fullReportPath)) fs.unlinkSync(fullReportPath);
    });

    it('succeeds with exit code 0 when --output-json is an absolute path within repository root', async () => {
      const fullReportPath = path.join(hardenRepoDir, 'in-tree-report.json');
      if (fs.existsSync(fullReportPath)) fs.unlinkSync(fullReportPath);

      const res = await runGate({
        repositoryRoot: hardenRepoDir,
        outputJson: fullReportPath,
        silent: true,
      });
      assert.equal(res.exitCode, EXIT_CODES.SUCCESS);
      assert.ok(fs.existsSync(fullReportPath));
      if (fs.existsSync(fullReportPath)) fs.unlinkSync(fullReportPath);
    });

    it('succeeds with exit code 0 when --output-json directory begins with double dots without escaping (..reports/report.json)', async () => {
      const dotReportRel = '..reports/report.json';
      const fullDotReportPath = path.join(hardenRepoDir, dotReportRel);
      if (fs.existsSync(fullDotReportPath)) fs.unlinkSync(fullDotReportPath);

      const res = await runGate({
        repositoryRoot: hardenRepoDir,
        outputJson: dotReportRel,
        silent: true,
      });
      assert.equal(res.exitCode, EXIT_CODES.SUCCESS);
      assert.ok(fs.existsSync(fullDotReportPath));
      if (fs.existsSync(fullDotReportPath)) fs.unlinkSync(fullDotReportPath);
      const dotDir = path.dirname(fullDotReportPath);
      if (fs.existsSync(dotDir)) fs.rmdirSync(dotDir);
    });

    it('parses git diff containing filenames with spaces without truncating path', () => {
      const spaceFilePath = path.join(hardenRepoDir, 'src/my component with spaces.js');
      fs.writeFileSync(spaceFilePath, 'export const spaced = true;\n');
      execFileSync('git', ['add', spaceFilePath], { cwd: hardenRepoDir });

      const diffResult = readGitDiff({
        repositoryRoot: hardenRepoDir,
        staged: true,
      });

      assert.equal(diffResult.success, true);
      const found = diffResult.changedFiles.find(
        (f) => f.path === 'src/my component with spaces.js'
      );
      assert.ok(found, "File 'src/my component with spaces.js' must be parsed with full path intact");
      assert.equal(found.addedLines.length, 1);
      assert.equal(found.addedLines[0].content, 'export const spaced = true;');

      execFileSync('git', ['reset', 'HEAD', spaceFilePath], { cwd: hardenRepoDir });
      if (fs.existsSync(spaceFilePath)) fs.unlinkSync(spaceFilePath);
    });

    it('parses git diff containing renamed filenames with spaces', () => {
      const origFile = path.join(hardenRepoDir, 'src/file-to-rename.js');
      fs.writeFileSync(origFile, 'export const renameMe = 1;\n');
      execFileSync('git', ['add', origFile], { cwd: hardenRepoDir });
      execFileSync('git', ['commit', '-m', 'Add rename source'], { cwd: hardenRepoDir });

      const renamedFile = 'src/renamed file with spaces.js';
      execFileSync('git', ['mv', 'src/file-to-rename.js', renamedFile], { cwd: hardenRepoDir });

      const diffResult = readGitDiff({
        repositoryRoot: hardenRepoDir,
        staged: true,
      });

      assert.equal(diffResult.success, true);
      const found = diffResult.changedFiles.find((f) => f.path === renamedFile);
      assert.ok(found, `File '${renamedFile}' must be parsed with status 'renamed'`);
      assert.equal(found.status, 'renamed');
      assert.equal(found.oldPath, 'src/file-to-rename.js');

      resetToBaseline();
    });

    it('parses git diff containing non-ASCII UTF-8 filenames with core.quotepath enabled', () => {
      execFileSync('git', ['config', 'core.quotepath', 'true'], { cwd: hardenRepoDir });
      const cafeFile = path.join(hardenRepoDir, 'src/café-module.js');
      fs.writeFileSync(cafeFile, 'export const cafe = true;\n');
      execFileSync('git', ['add', cafeFile], { cwd: hardenRepoDir });

      const diffResult = readGitDiff({
        repositoryRoot: hardenRepoDir,
        staged: true,
      });

      assert.equal(diffResult.success, true);
      const found = diffResult.changedFiles.find((f) => f.path === 'src/café-module.js');
      assert.ok(found, "File 'src/café-module.js' must be parsed with full path and exact UTF-8 characters intact");
      assert.equal(found.addedLines.length, 1);

      execFileSync('git', ['commit', '-m', 'Add cafe module'], { cwd: hardenRepoDir });
      const renamedCafe = 'src/café-renamed.js';
      execFileSync('git', ['mv', 'src/café-module.js', renamedCafe], { cwd: hardenRepoDir });

      const renameResult = readGitDiff({
        repositoryRoot: hardenRepoDir,
        staged: true,
      });

      assert.equal(renameResult.success, true);
      const renamedFound = renameResult.changedFiles.find((f) => f.path === renamedCafe);
      assert.ok(renamedFound, `File '${renamedCafe}' must be parsed with status 'renamed'`);
      assert.equal(renamedFound.status, 'renamed');
      assert.equal(renamedFound.oldPath, 'src/café-module.js');

      resetToBaseline();
    });

    it('enumerates untracked files with non-ASCII and special characters using NUL delimiter', () => {
      const untrackedCafeFile = path.join(hardenRepoDir, 'untracked-café.txt');
      fs.writeFileSync(untrackedCafeFile, 'untracked cafe text\n');

      const diffResult = readGitDiff({
        repositoryRoot: hardenRepoDir,
        includeUntracked: true,
      });

      assert.equal(diffResult.success, true);
      assert.ok(
        diffResult.untrackedFiles.includes('untracked-café.txt'),
        'untrackedFiles must contain unquoted non-ASCII name'
      );
      const foundObj = diffResult.changedFiles.find((f) => f.path === 'untracked-café.txt');
      assert.ok(foundObj, 'changedFiles must contain untracked non-ASCII file');
      assert.equal(foundObj.status, 'untracked');

      if (fs.existsSync(untrackedCafeFile)) fs.unlinkSync(untrackedCafeFile);
    });

    it('extracts package name from finding.explanation when details is omitted (schema conformance)', () => {
      const schemaConformingFinding = createBaseFinding({
        title: 'RULE-NO-UNNECESSARY-DEPENDENCIES',
        explanation: "Package 'used-lib' was added to production dependencies with zero references.",
        evidence: '"used-lib"',
      });
      delete schemaConformingFinding.details;

      const res = validateFindingEvidence(schemaConformingFinding, { repositoryRoot: hardenRepoDir });
      assert.equal(res.status, FINDING_STATUSES.UNVERIFIED);
      assert.ok(res.rejectionReason.includes('referenced in'));
    });

    it('confirms verified blocking violation when package name is in explanation without details', () => {
      const schemaConformingUnused = createBaseFinding({
        title: 'RULE-NO-UNNECESSARY-DEPENDENCIES',
        explanation: "Package 'unused-lib' was added to production dependencies with zero references.",
        location: {
          filePath: 'package.json',
          lineRange: { start: 6, end: 6 },
        },
        evidence: '"unused-lib"',
      });
      delete schemaConformingUnused.details;

      const res = validateFindingEvidence(schemaConformingUnused, { repositoryRoot: hardenRepoDir });
      assert.equal(res.status, FINDING_STATUSES.VERIFIED);
      assert.equal(res.valid, true);
      assert.equal(res.finding.blocksWorkflow, true);
    });
  });
});
