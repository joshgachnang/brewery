> Vendored from TerrenoLabs/terreno `plugins/terreno-claude/skills/2-pick/SKILL.md`
> (see `../../terreno-shared/VENDORED.md`). Driven by the `barrel` skill; not invoked on its own.


# Pick — build

Implement one approved slice carefully, then continue the pick-roast inner loop.
Pick's internal reviewers ask whether engineering was disciplined; they do **not**
replace Roast's independent proof. Pick never skips Roast.

Read the shared [`lifecycle contract`](../../terreno-shared/lifecycle-contract.md),
[`documentation contract`](../../terreno-shared/documentation-contract.md),
[`PR deployments`](../../terreno-shared/pr-deployments.md),
[`pick-roast loop`](../../terreno-shared/pick-roast-loop.md),
[`testing guidance`](../../terreno-shared/testing.md),
[`mocking guidance`](../../terreno-shared/mocking.md), and
[`subagent briefing`](../../terreno-shared/subagent-briefing.md).

## Preconditions

- An approved IP/task contract exists.
- One current unblocked task/slice is identifiable.
- Branch and prior execution state are available.

## Inputs

- Approved IP, task file, current task, and applicable acceptance criteria
- Branch/current head and execution state
- Selected/discoverable repository skills and instructions
- Prior Pick attempts
- Exact Roast failures or Taste/CI/review evidence when retrying
- Known blockers and existing artifacts

## Procedure

1. **Reconstruct.** Verify the approved plan, current task, branch/head, prior result, and
   already-verified behavior. Do not redo completed work. Resume the inner loop at the
   next unblocked incomplete task, or at the same task when retrying a Roast `FAIL`.
   When a harness pushed earlier slices automatically and product CI on that pushed
   head reports a branch-caused failure, fixing it is the current task.
   Do not start or continue another slice on a red head. Never wait on pending CI;
   read the latest terminal results and keep building. Record flaky, infrastructure,
   or other failures the branch did not cause in execution state for Taste; they do
   not block the next slice. After Brew, CI reactions belong to Taste.
2. **Read architecture docs.** Load the current architecture and domain docs for the
   files/seams in this slice. Implement against that design; if the slice changes it,
   update those docs in the same slice.
3. **Discover supporting skills.** Inspect available project skills for this slice's
   files; load applicable implementation, testing, documentation, safety, and runtime
   guidance. Do not load the whole catalog.
4. **Focus retries.** Convert prior failure evidence into a hypothesis and the smallest
   safe change. Record attempted approaches; do not repeat one without new evidence.
5. **Specify.** State one caller-visible behavior and the highest public seam that proves
   it. List its edge cases before writing code: empty, missing, and error inputs;
   loading and disabled states; boundaries; permissions; web versus native. Take them
   from the acceptance criteria and repository test rules. Each one becomes a test in
   this slice, so Roast proves them instead of discovering them.
6. **Encode.** Add one failing test and run the repository's closest test command. Confirm
   it fails for the intended product reason.
7. **Fulfill.** Implement the minimum code that passes. Prefer real integrations and
   narrow injected fakes at true external boundaries.
8. **Clean the Kitchen.** Once the vertical slice is green, refactor names/structure,
   remove debug/dead code, and rerun the affected repository-prescribed checks.
9. **Review independently.** Build one task-scoped briefing (criteria, file list, this
   slice's patch). In fresh contexts, give **that briefing** to:
   - implementation/spec review
   - test-quality review (public behavior, independent expected values, realistic
     boundaries, no leaky/global test doubles)
   Do not let each reviewer rediscover skills or diff the whole branch. Fix material
   findings and rerun affected checks.
10. **Check drift, docs, and runtime.** Compare the diff to the current task/IP. Update
    architecture and public docs in this slice using the documentation contract. Run any
    mandatory runtime/UI/safety verification declared by repository instructions or
    supporting skills. Missing mandatory capability is `BLOCKED`, not skipped.
    Missing docs for a user-visible or architectural change is `FAIL`.
11. **Record.** Record the completed task/slice in execution state with commands,
    evidence, artifacts, docs files, and attempts. Do not commit a separate task-file
    edit to mark progress; the task-file mark rides in this slice's commit (step 13).
12. **Prove this task.** Follow [`roast.md`](roast.md) to prove this task only. Prefer a fresh context
    and pass the same task-scoped briefing. Roast must not spawn two unconstrained
    reviewers. Roast must return after classifying this task. Roast never invokes Pick.
    Do not start the next task until Roast PASS.
    Exactly one driver continues — that driver is this Pick.
13. **Commit once.** After Roast `PASS`, make one behavior-scoped commit for the task:
    code, tests, docs, the task-file mark, and any fixes Roast forced. Fold Roast-driven
    fixes into the task's unpushed commit instead of adding "harden", "strengthen", or
    "mark roasted" follow-ups. Do not push during Pick; Brew pushes. When the harness
    pushes every commit automatically, commit only after Roast `PASS` for the same
    reason. Follow the [commit and push rules](../../terreno-shared/pick-roast-loop.md#commits-and-pushes).
14. **Continue or stop.** After Roast `PASS`, if unblocked incomplete tasks remain,
    reconstruct the next frontier task and repeat from Reconstruct so architecture docs
    and supporting skills are rediscovered for that slice. If none remain, emit
    `PASS` with `next: brew`. Roast `FAIL` retries this task from Focus retries. Emit
    `FAIL` with `next: pick` only when this invocation must exit for a new hypothesis
    the current context cannot safely continue. `BLOCKED` exits the loop. Pick owns
    the inner loop. Do not rely on Roast to start the next Pick.

Repeat Specify → Encode → Fulfill for learned behaviors inside this one slice. Do not
batch all tests first. Do not expand into the next task until Roast PASS.

## Supporting skills

Follow the shared discovery procedure. Project skills own exact commands, framework
patterns, schema/data rules, test environment, UI verification, prompt governance,
generated-code workflows, and repository gotchas.

## Evidence produced

- Files/behavior completed for each task this invocation finished
- Red and green test evidence plus required lint/type/build/runtime results
- Internal review results
- Drift decision and artifact references
- Attempted-approach summary (especially on retries)
- Per-task Pick and Roast results in execution state
- Terminal structured Pick or inner-loop result

## Success conditions

- Every in-scope task this invocation reached has Roast `PASS` on the recorded head.
- Required repository checks/runtime gates pass for the current head.
- No unresolved internal review findings or plan drift remain on completed tasks.
- When unblocked tasks remain, continue the loop rather than exiting.
- When none remain, emit `PASS` with `next: brew`.

## Failure conditions

Tests, internal reviews, or implementation checks that objectively fail emit `FAIL` with
expected/actual/evidence and `next: pick` only with a focused next
hypothesis; otherwise escalate under blocked conditions.

## Blocked conditions

An unresolved product/security/data/public-API decision, unsafe destructive change,
missing required verifier, inaccessible dependency, or scope expansion emits `BLOCKED`
with `next: null` and the exact decision/action required.

## Recommended next stage

- Inner-loop `PASS` (all in-scope tasks roasted) → `next: brew`
- Current task built, Roast not yet run → `next: roast` (invoke Roast in-process)
- `FAIL` → `next: pick` with preserved evidence and a new hypothesis
- `BLOCKED` → outer loop routes the named gate
