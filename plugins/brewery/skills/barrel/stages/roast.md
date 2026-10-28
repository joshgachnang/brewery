> Vendored from TerrenoLabs/terreno `plugins/terreno-claude/skills/3-roast/SKILL.md`
> (see `../../terreno-shared/VENDORED.md`), with brewery's test-integrity checks in step 3.
> Driven by the `barrel` skill; not invoked on its own.


# Roast — prove

Roast is the authoritative stage-level verifier for the **current task**. It does not
continue the inner loop. Roast never invokes Pick. Pick owns the inner loop:

```text
requirement → verification method → evidence → PASS / FAIL / BLOCKED
```

Read the shared [`lifecycle contract`](../../terreno-shared/lifecycle-contract.md),
[`documentation contract`](../../terreno-shared/documentation-contract.md),
[`PR deployments`](../../terreno-shared/pr-deployments.md),
[`pick-roast loop`](../../terreno-shared/pick-roast-loop.md),
[`testing plan`](../../terreno-shared/testing-plan.md),
[`user guide`](../../terreno-shared/user-guide.md), and
[`subagent briefing`](../../terreno-shared/subagent-briefing.md).

## Preconditions

- An approved IP/task contract and completed Pick result exist for the current task.
- Current branch/head and diff are resolvable.
- Run in a fresh context when the harness permits, with a task-scoped briefing.

## Inputs

- IP, task file, acceptance criteria, and verification requirements for the current task
- Current branch/head, diff, and PR when present
- Pick result, execution state, prior Roast attempts, and artifacts
- Repository instructions and available project/verification skills

## Procedure

1. **Reconstruct independently.** Verify the head and this task's source artifacts from
   the task-scoped briefing (criteria, file list, patch). Do not trust Pick's completion
   claims as proof. Do not reload unnamed lifecycle references or the whole skill catalog.
2. **Discover supporting skills.** Load only skills whose descriptions match this task's
   files and criteria. Repository-mandatory capabilities are hard requirements.
3. **Build the matrix.** Map every in-scope criterion **for the current task** to one or
   more objective methods and the evidence required. Include promised regressions,
   compatibility, and non-scope that this task could break. Check the tests written first
   for this task against its test brief: every `Cases` entry and criterion has a test,
   expected values are the brief's literals, and each `Blast radius` consumer has its case
   at the assigned layer. Review every change Pick made to those tests, with its reason. For a
   UI task, every state its snapshot artboards show (`docs/specs/<slug>/design/`) is a
   criterion: copy, fields, and empty, loading, and error states match the snapshot, not
   the live canvas. A missing case, a wrong expected value, a test that cannot fail, or a
   change that weakens a criterion is `FAIL`; mark it `retest: true` when the defect is in
   the tests rather than the code, so the test stage writes them again. An `untestable` claim that a test could
   disprove is the same. Add every IP `## E2E tests` row whose `Written in` names this
   task, with the command that runs its spec at the row's path, following the e2e guide
   the testing plan resolves. A missing spec is `FAIL` that names the row ID. Run `http`
   and `process` rows here; a `browser` or `native flow` row only typechecks here and is
   recorded `deferred` with its exact command per the testing-plan deferral rule, for
   the integrated Roast. Record a deferred row in the Roast result and execution state,
   never in the IP tables, and never count it as passed. Add every IP
   `## Regression cases` row this task's criteria name, or whose `Automated by` names one
   of this task's rows or specs; in the integrated Roast, add every row no earlier Roast
   checked. A row without a concrete starting state, a followable action, and an
   observable Expected is `FAIL` that names the row ID and the missing part; so is a row
   an e2e guide layer could cover completely, or one that repeats an existing suite
   case. Roast never walks a row. An IP that lacks either section follows the
   testing-plan legacy rule: warn once and do not fail.
4. **Inspect and execute.** Review this task's patch and run concrete checks in this
   invocation: repository-prescribed tests, integration/system behavior, lint/type/build
   checks, runtime/API/database probes, regression reproductions, or real UI interaction.
   Do not spawn two unconstrained reviewers. Prefer named commands here over a second
   general-purpose child that rediscovers the repo. Run the fast tiers (see
   [`testing guidance`](../../terreno-shared/testing.md#test-tiers)) for the touched
   packages, not only this task's test file: the root `prepush` package script when
   present, otherwise each touched package's lint, typecheck, and unit/integration test
   command, including coverage thresholds. A test that passes alone but fails in the
   package suite is `FAIL`. Do not run e2e or browser suites here.
5. **Exercise changed behavior.** Per-task Roast does not launch the app or run browser
   suites. For UI-facing work, prove what component and integration tests can, check that
   any new or changed e2e spec typechecks, and record the browser-only criteria as
   deferred. The integrated Roast, after every task lands, runs the e2e suites and
   spawns at most one specialized UI/runtime verifier that interacts with the actual
   changed workflows and captures screenshots/video/logs. App launch alone is not proof.
6. **Prove docs.** Confirm architecture and public docs match the shipped behavior. A
   criterion that is true in code but absent or wrong in docs is `FAIL`. Check each
   `## User guide` page whose row names this task against the user-guide guide-entry bar
   and the shipped screens: every label a step names exists in the source, the steps
   reach the outcome `## What it does` promises, and `audience` and `platforms` match
   who can reach the feature. The integrated Roast's UI verifier walks the pages' steps.
   A missing page, a page that misses the bar, or steps that do not match the shipped
   screens is `FAIL` that names the row ID. Skip this when the repository opts out of
   the user guide; an IP that lacks the section follows the user-guide legacy rule.
7. **Classify each criterion.** Record `PASS`, `FAIL`, or `BLOCKED` with reproducible
   evidence. Never pass a criterion because the code merely looks reasonable.
8. **Do not fix.** Report implementation defects to Pick. Only correct verifier setup
   owned by Roast; if that changes evidence materially, rerun the affected method.
9. **Record.** Update execution state for this task's Roast result.
10. **Return.** Follow the pick-roast loop. Do not start the next task until Roast PASS.
    Roast never invokes Pick. Pick owns the inner loop. Exactly one driver continues —
    that driver is always Pick. After recording this task, return the result; do not
    reconstruct Pick, do not invoke Pick, and do not start the next task. `PASS` with
    remaining unblocked tasks → emit `PASS` with `next: pick`. `PASS` with none remaining
    → emit `PASS` with `next: brew`. `FAIL` → emit `FAIL` with `next: pick`. `BLOCKED`
    → emit `BLOCKED` with `next: null`. When Pick invoked this Roast, returning to Pick
    is enough; still do not invoke Pick.

Do not treat a Roast of the last slice as proof of earlier unroasted tasks. Terminal
inner-loop `PASS` requires every in-scope task to have Roast `PASS` on the recorded head.

## Supporting skills

Follow the shared discovery procedure. Applicable skills may supply API/database test
methods, UI/runtime verification, security/safety checks, build commands, or deployment
probes. If repository policy makes one mandatory and it is unavailable, emit `BLOCKED`.

## Evidence produced

- Requirement-to-evidence matrix for the current task
- Commands/probes/interactions and outcomes
- Artifact/log/API response references
- Exact expected vs actual behavior for every failure
- Environment/access details for every blocker
- Docs pages that match or fail against shipped behavior
- Each `## E2E tests` row this task owns, with its spec path, command, and `PASS`,
  `FAIL`, or `deferred`
- Each `## Regression cases` row checked against the regression-step bar, and its result
- Each `## User guide` row this task owns, with its page and result against the
  guide-entry bar and the shipped screens
- Per-task Roast results in execution state
- Terminal structured Roast or inner-loop result

## Success conditions

- Every in-scope acceptance criterion for the current task has objective passing
  evidence on the recorded head.
- Required regression/runtime/UI checks pass.
- Architecture and public docs match the shipped behavior.
- Every `## E2E tests` row this task owns has a spec at its path that passed here, or is
  recorded `deferred` with its exact command.
- Every `## Regression cases` row Roast checked meets the regression-step bar.
- Every `## User guide` page this task owns meets the guide-entry bar and matches the
  shipped screens.
- Remaining unblocked tasks emit `next: pick`. Roast never invokes Pick.
- When none remain and every in-scope task has Roast `PASS`, emit `PASS` with
  `next: brew`.

## Failure conditions

One or more criteria disproven by evidence emits `FAIL` with severity, expected, actual,
and reproducible evidence. Set `next: pick`. A missing or failing `## E2E tests` row, a
`## Regression cases` row that misses the regression-step bar, could be fully automated,
or repeats an existing case, and a `## User guide` row whose page is missing, misses the
guide-entry bar, or does not match the shipped screens are each `FAIL` that names the
row ID.

## Blocked conditions

Unavailable required environment/capability/access, ambiguous criterion requiring a human
decision, or external service failure that prevents proof emits `BLOCKED` with exact
classification, `next: null`, and next action.

## Recommended next stage

- Inner-loop `PASS` (all in-scope tasks roasted) → `next: brew`
- `PASS` with remaining unblocked tasks → `next: pick`
- `FAIL` → `next: pick` with exact failure evidence and current head
- `BLOCKED` → outer loop classifies retryable environment/external vs human gate
