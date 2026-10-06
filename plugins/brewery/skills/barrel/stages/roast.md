> Vendored from TerrenoLabs/terreno `plugins/terreno-claude/skills/3-roast/SKILL.md`
> (see `../../terreno-shared/VENDORED.md`). Driven by the `barrel` skill; not invoked on its own.


# Roast — prove

Roast is the authoritative stage-level verifier for the **current task**. It does not
continue the inner loop. Roast never invokes Pick. Pick owns the inner loop:

```text
requirement → verification method → evidence → PASS / FAIL / BLOCKED
```

Read the shared [`lifecycle contract`](../../terreno-shared/lifecycle-contract.md),
[`documentation contract`](../../terreno-shared/documentation-contract.md),
[`PR deployments`](../../terreno-shared/pr-deployments.md),
[`pick-roast loop`](../../terreno-shared/pick-roast-loop.md), and
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
   compatibility, and non-scope that this task could break.
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
   criterion that is true in code but absent or wrong in docs is `FAIL`.
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
- Per-task Roast results in execution state
- Terminal structured Roast or inner-loop result

## Success conditions

- Every in-scope acceptance criterion for the current task has objective passing
  evidence on the recorded head.
- Required regression/runtime/UI checks pass.
- Architecture and public docs match the shipped behavior.
- Remaining unblocked tasks emit `next: pick`. Roast never invokes Pick.
- When none remain and every in-scope task has Roast `PASS`, emit `PASS` with
  `next: brew`.

## Failure conditions

One or more criteria disproven by evidence emits `FAIL` with severity, expected, actual,
and reproducible evidence. Set `next: pick`.

## Blocked conditions

Unavailable required environment/capability/access, ambiguous criterion requiring a human
decision, or external service failure that prevents proof emits `BLOCKED` with exact
classification, `next: null`, and next action.

## Recommended next stage

- Inner-loop `PASS` (all in-scope tasks roasted) → `next: brew`
- `PASS` with remaining unblocked tasks → `next: pick`
- `FAIL` → `next: pick` with exact failure evidence and current head
- `BLOCKED` → outer loop classifies retryable environment/external vs human gate
