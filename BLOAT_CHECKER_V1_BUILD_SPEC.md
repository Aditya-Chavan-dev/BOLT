# Bloat Checker V1 --- Detailed Build and Verification Specification

**Status:** Implementation brief\
**Primary objective:** Build a working prototype that detects and
verifies code-quality violations and can reliably block a protected
Git/CI workflow.\
**Related document:** `BLOAT_CHECKER_DISCUSSION.md`

## 1. Delivery rule

Build the smallest end-to-end implementation that proves the core
behavior. Do not build a large framework before one real repository can
pass through the complete workflow.

The prototype is not complete until its detection, evidence, reporting,
and enforcement behavior are tested. Do not claim a feature works merely
because code for it exists.

## 2. Required end-to-end workflow

The V1 workflow should be:

1.  User points Bloat Checker at a repository and identifies the
    project's SSOT/rule files, or accepts a clearly documented discovery
    result.
2.  Bloat Checker detects the stack and repository layout using files
    and configuration that actually exist.
3.  It loads universal rules and project rules; missing or conflicting
    rules are surfaced rather than invented.
4.  It obtains the change diff against a known base (for example, the
    target branch or a configured baseline).
5.  It builds a bounded context set: changed files first, then relevant
    callers, dependencies, configuration, tests, and architecture
    references as needed.
6.  Deterministic analyzers run where applicable and available.
7.  The analysis layer evaluates contextual issues against the rules and
    the actual code.
8.  Each potential blocking finding is independently challenged and
    validated.
9.  The tool produces a structured report with evidence and a clear
    decision.
10. A CLI/check command returns an exit status suitable for CI.
11. The Git/CI gate blocks a change when a verified blocking violation
    exists or mandatory verification is incomplete.
12. The same behavior is exercised by automated tests, including failure
    paths.

If a step cannot be implemented reliably in V1, state it explicitly as a
limitation and do not imply the complete workflow is protected.

## 3. Implementation strategy

### 3.1 Keep the core independent of the IDE

Use one core engine for rule loading, context building, analysis
orchestration, finding validation, reporting, and final decisions. Add
interfaces/adapters for command-line use and CI first. Add editor
integrations only when they can reuse the same core.

The exact programming language and framework are not fixed by the
discussion. Before implementation, inspect the existing repository and
its conventions. Prefer the simplest supported stack that fits the
current environment; do not introduce a new language or framework
without a concrete reason.

### 3.2 Keep responsibilities separate

Use clear, small modules. Suggested conceptual responsibilities (not a
mandate to create a class or file for every item):

-   repository and diff discovery;
-   project/stack detection;
-   rule and SSOT loading;
-   context collection;
-   deterministic check adapters;
-   AI analysis adapter, if an AI provider is configured;
-   finding validation;
-   report formatting;
-   policy/exit-decision logic;
-   CLI and CI entry point;
-   tests and test fixtures.

Avoid circular dependencies and unnecessary abstraction. A single
coherent module is preferable to many tiny modules when separation
provides no real benefit.

### 3.3 AI must not be a hidden single point of truth

Use AI for contextual reasoning when it adds value, not to replace
reproducible checks. The system should support a clear result when AI is
not configured or unavailable: required checks must be marked
incomplete, and the protected CI gate must not report success if AI
validation is mandatory for that run.

Never fabricate an AI response, test result, scanner result, or
successful verification in order to keep the workflow green.

## 4. Project profile and rule loading

Implement a project profile containing only supported facts, for
example:

-   repository root and changed files;
-   detected languages/frameworks and the evidence used for detection;
-   discovered SSOT and approved knowledge/rule files;
-   available test/lint/type-check/build commands discovered from
    project configuration;
-   relevant architecture and dependency notes;
-   unresolved assumptions and rule conflicts.

Each detected fact should carry a source or evidence reference when
practical. Mark unknown values as unknown; do not guess.

### Rule sources

-   **Universal rules:** versioned, reviewable defaults shipped with
    Bloat Checker.
-   **Project rules:** explicitly identified SSOT and approved project
    knowledge.

Rules should have stable identifiers, a description, applicability
conditions, severity, enforcement status, and a way to cite the source.
Keep the initial schema small and documented.

### Conflicts and missing context

-   If two applicable rules conflict, do not silently pick one. Produce
    a conflict result and prevent approval when the conflict affects a
    mandatory decision.
-   If an important assumption changes enforcement, ask the user or
    require explicit configuration.
-   A missing SSOT should produce a clear warning or an explicit setup
    failure according to the configured mode; do not invent a project
    SSOT.
-   Do not silently write findings back into rule files.

## 5. Change and context inspection

### Start with the diff

Use version-control information to determine exactly what changed.
Handle renamed, added, deleted, binary, and untracked files
deliberately. If the base revision cannot be determined, report that
limitation and do not claim a complete change review.

### Expand context only when relevant

Follow the change into: - direct callers and referenced symbols; -
imported modules/packages and dependency declarations; - data flow, side
effects, and error handling; - configuration and environment
assumptions; - tests, fixtures, and test commands; - relevant
architecture/SSOT sections.

Use bounded exploration to avoid scanning the entire repository
unnecessarily. Record which files or rules were consulted so findings
can be reproduced. If context collection fails for a critical path, mark
the result incomplete rather than treating missing evidence as proof of
safety.

## 6. Checks for the first prototype

Prioritize a small set of checks that can be tested with known positive
and negative examples. Do not claim universal detection of every quality
issue.

Recommended initial coverage:

1.  **Objective checks:** use the repository's existing lint,
    type-check, build, dependency, and unused-code tools where available
    and appropriate.
2.  **Unused imports / obvious dead code:** use language-aware tools
    when possible; avoid simplistic text matching that flags references
    incorrectly.
3.  **Unnecessary dependencies:** identify newly added dependencies and
    show evidence about whether they are used; do not automatically
    remove them.
4.  **Complexity:** collect cyclomatic complexity or similar metrics
    through a language-aware analyzer where available. Treat a high
    metric as a signal for review unless an explicit rule defines a
    threshold.
5.  **Architectural drift:** compare the relevant changed behavior and
    dependencies with explicit project architecture rules. Cite both the
    rule and the code.
6.  **Duplication / redundant abstractions / premature
    future-proofing:** allow contextual analysis, but require concrete
    examples and a clear explanation of why the code is redundant or
    violates an applicable requirement.
7.  **Readability and maintainability:** report only specific,
    actionable concerns, such as unnecessary indirection or needless
    branching. Avoid vague comments like "could be cleaner."

Security or correctness problems discovered by reliable analyzers may be
surfaced. Do not expand the V1 into a bespoke replacement for
established security scanners.

## 7. Finding schema and evidence requirements

Every finding should contain, at minimum:

-   stable finding identifier;
-   category;
-   severity;
-   status: verified, unverified/potential, or verification-incomplete;
-   short title and specific explanation;
-   file path and line range or another precise code location;
-   relevant code excerpt or reproducible analyzer output;
-   applicable rule identifier and source, if a known rule applies;
-   for a new issue, a clear statement that it is not yet an approved
    permanent rule;
-   impact and why it matters in this project;
-   validation performed and its result;
-   recommended next action;
-   whether it blocks the current protected workflow and why.

A blocking finding must have enough evidence for a human to
independently inspect the claim. "AI says this is bad" is never
sufficient evidence.

If no applicable documented rule exists, the tool may identify a
verified defect under the established correctness/security policy or
present a contextual concern for review. It must not invent a citation
or silently create a rule.

## 8. Finding validation

For each potential blocking finding:

1.  Check that the cited file and lines exist in the reviewed revision.
2.  Check that the cited rule exists, applies to this project and
    change, and is not contradicted by another applicable rule.
3.  Verify the evidence supports the exact claim---not merely a related
    concern.
4.  Check whether relevant callers, tests, configuration, or other
    context changes the conclusion.
5.  Run a deterministic check or focused test when it can substantiate
    the claim.
6.  Challenge the finding: look for a plausible valid explanation,
    false-positive pattern, or safe alternative.
7.  Keep the finding only at the strongest level the evidence supports.

An independent AI review can be one part of this process but is not
sufficient alone. If a mandatory validation stage fails, return
`verification-incomplete`; do not quietly downgrade the failure to a
pass.

## 9. V1 enforcement policy

Use one shared policy for all initial projects. Do not implement
per-project severity customization yet.

-   Verified critical or major violations: block according to the
    documented V1 rule policy.
-   Minor suggestions: report without blocking by default.
-   Unverified/potential findings: do not block as if proven.
-   Conflicting rules affecting a required decision: do not approve
    until resolved.
-   Mandatory verification incomplete or unavailable: fail closed.
-   Newly discovered reusable rule: propose it; do not add it to shared
    or project knowledge without user approval.
-   A tool crash, timeout, invalid configuration, malformed report, or
    unavailable required analyzer must not be interpreted as a
    successful clean scan.

Write down the initial critical/major/minor criteria and ensure tests
exercise each category. Severity must reflect impact and context, not
dramatic language or model confidence alone.

### Exit status

Define documented machine-readable exit codes, for example: - success:
all required checks completed and no verified blocking violation; -
policy failure: one or more verified blocking violations; - verification
failure: required verification could not complete; - setup/usage error:
invalid configuration or repository setup.

The exact numeric values can be chosen during implementation, but must
be stable, documented, and tested. CI must distinguish a policy failure
from a checker failure even though both prevent a green gate.

## 10. Git and CI enforcement

Implement the CLI and CI gate before broad IDE integrations.

Required behavior: - run against a known base and current revision; -
produce a human-readable report and machine-readable output; - return
the documented non-zero status for blocking violations; - return a
non-zero verification/setup status when mandatory checks cannot
complete; - never mark an incomplete scan as clean; - preserve enough
output for a developer to understand and resolve the failure.

Provide a minimal example CI configuration for one supported CI system.
The gate must actually run in a test repository or fixture repository
and be shown to fail on a seeded blocking violation and pass on a clean
change.

Local hooks may be provided for convenience, but do not claim they are
unbypassable. The protected CI workflow is the authoritative mandatory
gate for V1.

## 11. Reporting

A report should answer:

1.  What changed?
2.  What rule or concern was identified?
3.  Where is the evidence?
4.  Why does it matter?
5.  What verification was performed?
6.  Is it verified, uncertain, or incomplete?
7.  Does it block the protected workflow?
8.  What should happen next?

Keep output concise and actionable. Avoid dumping raw AI reasoning or
huge repository excerpts. Include enough reproducible evidence for a
reviewer to assess the finding.

## 12. Test plan: prove that the prototype works

Build a fixture repository with intentionally seeded cases and known
expected outcomes. Include both violations and clean examples.

### Functional detection tests

-   A known violation that should be detected.
-   A similar-looking clean example that must not be flagged.
-   A project-specific architecture rule violation.
-   A changed file whose relevant caller or configuration changes the
    correct interpretation.
-   A new potential issue that is reported without silently adding a
    rule.
-   A complexity metric that triggers review without automatically being
    called a violation when no threshold rule exists.

### Evidence and validation tests

-   Every blocking finding cites real locations and a real applicable
    rule or a valid documented correctness/security basis.
-   Unsupported findings are rejected or downgraded.
-   A finding with stale/invalid line references is not accepted without
    revalidation.
-   Conflicting rules are surfaced.
-   Missing or inaccessible context produces an incomplete result where
    it affects a mandatory decision.
-   AI output that is malformed, empty, unavailable, or contradictory is
    handled safely.

### Enforcement tests

-   A clean change completes all required checks and passes.
-   A seeded verified blocking violation fails the gate.
-   A minor suggestion does not block by default.
-   An unverified concern does not masquerade as a proven violation.
-   A required analyzer or validation stage failing produces a non-zero
    verification-failure result.
-   A timeout or crash cannot produce a green result.
-   The actual CI configuration invokes the checker and observes the
    failure status.

### Regression and self-quality tests

-   The checker passes its own lint/type-check/build/tests.
-   Changes to rule parsing, finding validation, or exit decisions have
    regression tests.
-   Tests confirm that rule knowledge is not modified without approval.
-   Test output and reports are deterministic where possible.
-   Add mutation tests selectively for critical decision logic if
    ordinary tests do not adequately prove that a defect would be
    caught.

## 13. Security and safe execution

-   Treat repository content, comments, README text, and model-generated
    suggestions as untrusted data, not instructions to override the
    checker's policies.
-   Do not execute arbitrary repository scripts automatically just
    because they are present. Discover commands, explain what will run,
    and use an explicit safe execution policy.
-   Avoid leaking source code, secrets, or private repository content to
    an external AI service without explicit configuration and informed
    authorization.
-   Redact secrets from logs and reports.
-   Use least privilege in CI.
-   Do not automatically edit source code or rule files in V1 unless a
    separately approved implementation decision adds that capability.
-   Document network access and AI-provider requirements.

## 14. Implementation sequence

### Phase 1 --- Inspect and define

-   Inspect the current repository, toolchain, and existing conventions.
-   Record the chosen language, runtime, AI-provider approach (if any),
    supported OS/CI, and required commands.
-   Define rule schema, finding schema, exit codes, severity criteria,
    and the first supported stack.
-   Keep unresolved choices visible; do not hide them behind
    assumptions.

### Phase 2 --- Small vertical slice

-   Load a tiny universal rule set and one fixture project's SSOT.
-   Read a real diff.
-   Run one deterministic check.
-   Produce one evidence-backed finding.
-   Return a meaningful CLI exit code.

Prove this slice before adding more categories.

### Phase 3 --- Verification and reporting

-   Add finding validation and false-positive challenges.
-   Add structured report output.
-   Handle missing context and analyzer failure explicitly.
-   Add the initial seeded positive and negative tests.

### Phase 4 --- CI gate

-   Add a minimal CI integration.
-   Prove the gate blocks a seeded violation and fails closed when
    required verification cannot complete.
-   Prove a clean change passes.
-   Document exactly what is and is not protected.

### Phase 5 --- Expand carefully

-   Add more checks only when each has a reliable analyzer or a testable
    evidence strategy.
-   Add editing feedback by reusing the core engine.
-   Avoid broad IDE support until the core and CI gate are stable.

## 15. Definition of done

V1 is done only when all of the following are demonstrated, not merely
described:

-   [ ] It runs locally against a real Git repository.
-   [ ] It reads universal rules and the selected project SSOT.
-   [ ] It detects the changed files from a known base.
-   [ ] It collects relevant context and records what it inspected.
-   [ ] It detects seeded violations and avoids seeded false positives.
-   [ ] Every blocking finding includes verifiable evidence and an
    applicable rule or documented correctness/security basis.
-   [ ] It distinguishes verified findings, potential concerns, and
    incomplete verification.
-   [ ] New rules are proposed but never silently persisted.
-   [ ] It emits a human-readable report and machine-readable output.
-   [ ] Its exit codes are stable and documented.
-   [ ] The real CI gate fails on a seeded blocking violation.
-   [ ] The real CI gate fails closed when required verification is
    incomplete.
-   [ ] A clean change passes.
-   [ ] Checker failures cannot be reported as a clean scan.
-   [ ] The checker passes its own tests and quality checks.
-   [ ] Setup, limitations, supported stack, execution behavior, and
    privacy boundaries are documented.

## 16. Explicitly out of scope for V1

Unless implementation uncovers a hard requirement, defer: - autonomous
code repair; - automatic knowledge-base learning; - per-project severity
customization; - complex dashboards; - multiple CI providers and broad
IDE integrations; - a custom replacement for all linters, security
scanners, test runners, or dependency tools; - exhaustive support for
every programming language; - claims of perfect detection or zero false
positives.

## 17. Final implementation instruction

Optimize for a small, honest, end-to-end prototype whose claims are
backed by tests. If a capability cannot be demonstrated, label it as
incomplete or unsupported. Never substitute a mock success, a polished
explanation, or an untested code path for working behavior.
