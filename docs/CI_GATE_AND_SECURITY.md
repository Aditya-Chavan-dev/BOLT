# Bloat Checker V1 — CI Gate and Security Specification

## 1. Overview and Protected Boundary

Bloat Checker V1 is designed to operate as an authoritative CI (continuous integration — an automated server pipeline that builds and tests code on every push) gatekeeper.

### What the CI Gate Protects
- **Pull Requests and Mainline Merges**: The CI gate runs deterministically on GitHub Actions for pull requests and pushes targeting the primary branch (`main`).
- **Policy Enforcement**: Verified critical and major bloat violations (such as newly added, unused production dependencies) automatically fail the CI job with exit code `1` (`POLICY_FAILURE`), failing the status check.
- **Fail-Closed Verification**: If required checks cannot complete—including unresolvable Git base revisions, corrupted diffs, analyzer crashes, or rule conflicts—the gate fails closed with exit code `2` (`VERIFICATION_FAILURE`) or exit code `3` (`SETUP_ERROR`), marking the verification run as failed.
- **Merge Enforcement Prerequisite**: A failing CI job alone does not prevent merges unless GitHub branch protection is configured on `main` to require the `Bloat Checker Policy Gate` check to pass before merging.

### Why Local Hooks are Advisory (Not Authoritative)
- Local Git hooks (such as `pre-commit` or `pre-push`) are executed on individual developer machines.
- Any developer can easily bypass local hooks using `git commit --no-verify` or by committing in environments where hooks are not installed.
- Therefore, local hooks serve only as fast advisory feedback during editing; the centralized CI workflow on the server remains the single authoritative enforcement gate.

---

## 2. Security Boundaries and Safe Execution

To protect the host runner and surrounding infrastructure, Bloat Checker enforces strict security boundaries:

1. **Least-Privilege CI Permissions**:
   The workflow declares top-level `permissions: contents: read`. It requires zero write permissions, cannot push commits, cannot alter repository settings, and cannot modify releases.

2. **Zero Arbitrary Script Execution**:
   Bloat Checker inspects source code, dependency manifests (`package.json`), and lockfiles deterministically via static analysis. It **never** executes untrusted scripts, build commands, lifecycle hooks (`npm postinstall`), or external binaries present inside the repository being audited.

3. **No External Network Dependencies**:
   The gate runs 100% offline using Node.js built-ins. Source code, commit metadata, and diff excerpts are never transmitted to external cloud services or third-party APIs.

4. **Secret Protection**:
   Code and diff excerpts in human reports are bounded to the exact lines of flagged violations. Repository secrets and environment configurations are not ingested.

---

## 3. Base Revision Resolution and Push Handling

The CI gate evaluates changes against an explicitly determined base revision:

- **Pull Requests (`pull_request`)**:
  Compares against `origin/${{ github.base_ref }}` (the target branch, typically `origin/main`). Full history (`fetch-depth: 0`) is retrieved to ensure the merge base exists locally.
- **Push Events (`push`)**:
  Compares against the prior commit SHA (`${{ github.event.before }}`). If multiple commits were pushed, or on shallow clones, falls back to `HEAD~1` if verified.
- **Fail-Closed on Missing Base**:
  On an initial branch push or when prior commit history is missing, the workflow intentionally passes `MISSING_BASE_REVISION`. `git rev-parse --verify` fails, forcing exit code `3` (`SETUP_ERROR`). The gate never marks an unverifiable base as a clean pass.

---

## 4. Failure Diagnosis and Exit Codes

When a pull request or push fails the Bloat Checker gate, examine the GitHub Actions job summary and the generated `bloat-report.json` artifact:

| Exit Code | Decision | Meaning | Remediation |
|---|---|---|---|
| `0` | `pass` | Clean pass: all required checks completed with zero blocking violations. | None required; ready to merge. |
| `1` | `blocked` | Policy failure: one or more verified blocking violations were flagged. | Inspect the finding in the report. Remove or use the flagged dependency/bloat. |
| `2` | `incomplete` | Verification failure: a mandatory analyzer crashed, evidence was fabricated, or an active rule conflict exists. | Check error logs for check crashes, unreadable files, or conflicting SSOT rules. |
| `3` | `error` | Setup / configuration error: invalid repository root, unresolvable base revision, or unreadable rule file. | Verify repository clone depth (`fetch-depth: 0`) and target branch reference. |

---

## 5. Artifacts and Reporting

In every CI run (regardless of pass or fail status), the workflow produces:
1. **Console Human Report**: Plain-text summary answering the 8 core spec review questions directly in the GitHub Actions runner log.
2. **Machine-Readable JSON Artifact**: Structured JSON report (`bloat-report.json`) containing deterministic stats, check records, and finding items, uploaded via `actions/upload-artifact@v4`.

---

## 6. V1 Baseline and Audit Outcome

The V1 prototype baseline was evaluated against the 16 completion criteria defined in Section 15 of `BLOAT_CHECKER_V1_BUILD_SPEC.md`.

### Reported Audit Results
The IDE audit reported all 16 completion criteria as **PASS**, with the behavioral test suite reporting **45 passed, 0 failed, 1 skipped**.
*(Note: These figures represent reported results from the internal IDE audit execution, not independently reproduced third-party verification.)*

### Tracked Limitations and Operational Prerequisites
1. **GitHub Branch Protection Required**: The CI workflow is fully configured, but merge blocking is not operationally enforced on GitHub until branch protection rules requiring the `Bloat Checker Policy Gate` status check are enabled on the `main` branch.
2. **Windows Symlink Platform Restriction**: The symlink escape rejection test remains skipped in unprivileged Windows host environments due to operating system permission constraints.
3. **CLI Output Path Containment**: The `--output-json` option accepts absolute file paths; restricting report output paths strictly to the repository root or a dedicated artifacts directory remains an architectural hardening opportunity.

