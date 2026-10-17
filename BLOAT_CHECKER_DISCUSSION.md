# Bloat Checker --- Discussion Record and Product Decisions

**Status:** Working decision record for V1\
**Purpose:** Preserve the decisions made so far about Bloat Checker.
This is the reference for scope and intent; implementation details
belong in `BLOAT_CHECKER_V1_BUILD_SPEC.md`.

## 1. Purpose

Bloat Checker is a reusable engineering tool that inspects code changes
and helps prevent unnecessary complexity, architectural drift, avoidable
technical debt, and other quality problems from entering a codebase.

Its first priority is to become reliable enough to guard code changes
across projects. The initial goal is a working, verified prototype---not
an elaborate platform. Capabilities should be upgraded over time as real
use reveals needs.

## 2. Core operating principles

1.  **Working behavior over ambitious scope.** Implement the smallest
    useful V1 and prove that it works.
2.  **Evidence before enforcement.** A plausible-sounding AI explanation
    is not proof.
3.  **Reusable, project-aware behavior.** The tool should adapt to a
    project's stack, structure, rules, and relevant context without
    assuming every project is identical.
4.  **Universal rules plus project rules.** Use general engineering
    rules alongside the project's SSOT (single source of truth) and
    approved project knowledge.
5.  **Investigate rather than assume.** Start with the diff, then trace
    relevant dependencies, callers, data flows, configuration, tests,
    and architecture rules as needed.
6.  **Fail closed for mandatory verification.** If a protected workflow
    requires a check and that check cannot complete, do not authorize
    that workflow.
7.  **No unsupported claims.** A concern that lacks adequate evidence
    must not be represented as a proven violation.
8.  **Improve incrementally.** Avoid premature complexity and defer
    upgrades until they have a clear reason.

## 3. Where Bloat Checker operates

V1 should support three checkpoints:

-   **During editing:** fast feedback where a suitable integration is
    available.
-   **After an implementation step:** deeper analysis of the changed
    code and relevant project context.
-   **Before a change is accepted into the shared codebase:** mandatory
    Git/CI verification and enforcement.

The core checking logic should be reusable across integrations. Git/CI
is the mandatory enforcement foundation because relying on a coding
agent to remember to run a tool is not dependable.

A block is only guaranteed where Bloat Checker is connected to an
enforcement mechanism that can actually prevent progression. The
implementation must document exactly which workflow is protected; it
must not claim to block arbitrary editor or terminal actions that it
cannot control.

## 4. Project context and rules

Bloat Checker should build a project-specific rule profile using:

-   the project SSOT and approved project knowledge;
-   the repository structure and detected technology stack;
-   applicable configuration and existing engineering conventions;
-   the changed code and its relevant dependencies, callers, data flows,
    and tests.

Important assumptions should be shown for confirmation before they
become enforced project rules. Missing information must not be invented.

The policy has two rule sources:

1.  **Universal engineering rules**
2.  **Project-specific rules documented in the SSOT or approved project
    knowledge**

If applicable rules conflict, Bloat Checker must not silently choose
one. It should report the conflict and require an explicit resolution.

## 5. Known rules and new discoveries

Bloat Checker has two responsibilities:

-   enforce known, applicable rules;
-   discover potential defects or quality problems that are not
    explicitly listed in either rule source.

A rule does not need to be documented for the tool to discover a
possible problem. However, AI opinion alone must not turn an
undocumented preference into a blocking rule.

For a previously undocumented issue, the tool should gather evidence,
investigate impact, validate the concern, and classify it. A genuinely
serious, verified defect may be reported under the existing
safety/correctness policy, but a new permanent rule must not be silently
created.

**Approval-first policy:** newly discovered rules or reusable knowledge
require the user's approval before being added to the shared knowledge
base or project SSOT.

## 6. Inspection scope

Start with the changed lines and diff. Expand the investigation only as
needed to understand the change correctly, including:

-   callers and dependencies;
-   data flow and side effects;
-   configuration and environment assumptions;
-   tests and test coverage relevant to the change;
-   architecture and project rules;
-   package/dependency changes.

If the available evidence is insufficient, investigate further or mark
the result inconclusive. Do not assume a change is safe just because the
diff looks small.

## 7. Problems Bloat Checker should detect

The V1 design should account for the following categories, implementing
only checks that can be made reliable in the selected prototype:

-   unnecessary complexity and overengineering;
-   dead or unused code and imports;
-   unnecessary dependencies;
-   architectural drift from the SSOT;
-   premature future-proofing;
-   duplication and redundant logic;
-   avoidable technical debt;
-   unnecessary jargon, abstraction, or indirection;
-   code that technically works but is unnecessarily difficult to read,
    understand, change, or maintain;
-   excessive cyclomatic complexity.

Complexity metrics are evidence for investigation, not automatic proof
that code is bloated. A metric threshold alone must not establish a
contextual violation unless an applicable explicit rule says so.

Security and correctness concerns discovered during analysis should also
be surfaced when evidence supports them, even if they are not listed as
a specific Bloat Checker rule.

## 8. Evidence and verification model

Every finding that can block a change must go through a verification
process:

1.  Capture the diff and relevant project context.
2.  Collect evidence from source code, rule documents, configuration,
    dependency information, and appropriate automated checks.
3.  Analyze the change against universal and project-specific rules.
4.  Independently challenge the proposed finding: check whether the
    cited evidence actually supports the claim, whether context changes
    the interpretation, and whether a safe alternative exists.
5.  Verify the conclusion using reproducible checks or tests where
    feasible.
6.  Emit a structured finding with the evidence, rule, impact,
    confidence/verification status, and recommended next action.
7.  Enforce only according to the approved policy.

An independent AI review can help challenge a claim but is not, by
itself, a guarantee of correctness. Use deterministic tools and
executable verification where practical. Reject unsupported claims.

## 9. Enforcement decisions agreed so far

-   Bloat Checker must provide early feedback and deeper checks at
    agreed checkpoints.
-   Git/CI gates form the mandatory enforcement layer.
-   Mandatory checks must pass before the protected workflow is
    authorized.
-   If mandatory verification is incomplete or unavailable, the
    protected workflow must not be approved.
-   The tool must state limitations when an environment does not provide
    a reliable blocking mechanism.
-   There is one consistent V1 policy across all initial projects.
    Per-project severity customization is deferred.
-   Verified critical or major violations should block according to the
    V1 policy.
-   Minor suggestions should be reported without blocking by default.
-   Unverified findings must not be presented as proven violations.
-   The exact initial definitions of severity and which checks qualify
    as blocking must be specified and tested in the V1 build spec. The
    label alone must never substitute for evidence.
-   A newly discovered concern may be reported, but it must not become a
    permanent rule without user approval.
-   Automated repair behavior is not yet a locked requirement. V1 should
    focus on detecting, validating, reporting, and enforcing correctly
    rather than adding complex autonomous repair prematurely.

## 10. Categories of findings

At minimum, the report must distinguish:

-   **Verified violation:** evidence supports the claim and the
    applicable rule is clear.
-   **Potential/unverified concern:** evidence is insufficient; do not
    treat as a proven violation.
-   **Verification incomplete:** required validation could not finish;
    this affects authorization of the protected workflow, not the truth
    of an individual finding.
-   **New rule proposal:** a possible reusable rule that awaits user
    approval.
-   **Informational suggestion:** optional improvement that does not
    block by default.

## 11. Bloat Checker must meet its own standards

Bloat Checker is not exempt from scrutiny. Its own code, tests,
dependencies, complexity, maintainability, and enforcement behavior must
be reviewed.

V1 must include tests for: - correct detection of seeded violations; -
rejection of seeded false positives; - evidence and rule citations in
reports; - behavior when required checks fail or are unavailable; -
Git/CI enforcement actually blocking a failing change; - no silent
approval when verification is incomplete; - regression behavior after
changes to Bloat Checker.

Mutation testing may be introduced selectively when useful, but it is
not a mandatory platform feature for the first prototype unless needed
to validate a critical path.

## 12. Scope boundaries

V1 is not intended to be a complete enterprise engineering platform. Do
not build a separate custom system for every quality concern. Integrate
mature tools where they provide dependable checks, and build custom
logic where project-aware reasoning and evidence validation add
meaningful value.

Deferred items include: - project-specific severity profiles; -
automatic learning or silent rule updates; - autonomous code repair as a
required capability; - a large plugin marketplace or broad IDE
coverage; - advanced dashboards and analytics; - a complete enterprise
governance workflow.

These may be considered later based on demonstrated need.

## 13. V1 success definition

The prototype is successful only when it can be run against a real
repository and reliably demonstrate that it:

1.  reads the project context and rule sources;
2.  inspects a change and expands context when needed;
3.  detects known, seeded issues with supporting evidence;
4.  rejects or downgrades unsupported findings;
5.  reports previously undocumented potential issues without silently
    creating rules;
6.  requires approval before adding new rules to knowledge;
7.  runs at the required checkpoints;
8.  blocks a protected Git/CI workflow when a verified blocking
    violation exists;
9.  fails closed when mandatory verification is incomplete;
10. passes its own automated tests and has documented limitations.

A polished report or successful demo is not sufficient if enforcement,
failure behavior, or detection correctness has not been tested.
