# Test — write the task's tests first

> Original to brewery (not vendored). Driven by `barrel`: the CLI runs it as the `test`
> step before each task's Pick, and an interactive Pick hands it to the `brewery:test-writer`
> subagent. Not invoked on its own.

Write every test for **one task** before anyone implements it, from the task's brief rather
than from code. A writer that has seen the implementation tests what the code does. A writer
that has only the brief tests what the task asked for: its edge cases, error paths, and
permissions come from the criteria, not from the branches it can see. That is why this runs
before Pick, in its own context, on a cheaper model.

Read [`testing guidance`](../../terreno-shared/testing.md) and
[`mocking guidance`](../../terreno-shared/mocking.md).

## Inputs

- The IP's brief, Assumptions, and Decisions
- This task's block: acceptance criteria and its test brief (`Seam`, `Interface`, `Cases`,
  `Blast radius`, `Test skills`; see the distill skill's
  [task format](../../distill/references/distilling.md#the-test-brief))
- On a retest: the current tests and Roast's evidence

Not inputs: other tasks' blocks, the implementation's function bodies, prior Pick output,
execution state.

## Procedure

1. **Load the test skills** the task names, and the repository's testing instructions. In
   Terreno apps those are `terreno-backend-tests`, `terreno-frontend-tests`, and
   `terreno-mobile-tests`, and their layer tables pick the seam: an HTTP route through
   supertest, a model directly, a component through `renderWithTerreno`, a flow across
   screens in Playwright, native-only behavior in Maestro. When the brief names none, pick
   by seam the same way. When the layer has no test setup (no preload, `bun test` crashes
   on import), return `BLOCKED` naming the layer: setup is its own task, built with
   `terreno-test-setup`, because it edits config this step may not touch.
2. **Read the seam, not the code.** Read only what a caller sees: exports, signatures, route
   registrations, schemas, types, and the helpers, fixtures, and factories that existing tests
   near the seam already use. When the seam does not exist yet, the brief's `Interface` line is
   the contract. Import it as written there; the missing module is part of red.
3. **Write one test per case.** Every `Cases` entry and every acceptance criterion gets a
   test. Expected values are the literal ones in the brief, never recomputed with the
   algorithm under test. In Terreno backends: authenticate with `authWithToken` (only
   login tests really log in), assert errors with `expectAPIError` and the exact status
   (401 no token, 405 method permission, 403 object permission, 404 missing id), pin the
   response shape of user or PHI routes with `assertStrictResponseProperties`, assert
   third-party calls on the preload's mock handles, use `freezeTime` for time and
   `waitUntil` / `waitForDocuments` for async effects. Add the edge cases the criteria imply but the brief left out: empty,
   missing, and error inputs; boundaries; permissions and exact status codes; loading and
   disabled states; web versus native. Note each one you add in the result's `summary`.
4. **Cover the blast radius.** For each consumer in `Blast radius`, write the case at the
   layer the brief assigns it. A backend consumer gets a backend case. A user-visible consumer
   gets an e2e spec, written now and run in the integrated roast. In an e2e spec, arrange
   state through the API and act through the UI. Separate the world the spec only reads
   (seeded once) from the subject it mutates (created and reconciled every attempt), so the
   spec is retry-safe and independent of every other spec.
5. **Check hygiene.** When the package has `@terreno/test`, run
   `terreno-test-hygiene <files you wrote>` and fix what it reports: `mock.module` in a test
   file, sleeps, cache-busted imports, component snapshots. brewery runs it too and rejects
   the step on a violation.
6. **Prove red.** Run the fast-tier tests you wrote. Each must fail for the reason its case
   describes: the missing behavior, not a typo, a bad import path inside the test, or broken
   setup. A test that passes before the implementation does not test the new behavior. Fix it
   or drop it. On a retest the implementation exists, so new tests may pass.
7. **Return.** Do not commit. Report `tests` (every file you wrote or changed), `command` (one
   command from the repository root that runs exactly the fast-tier tests and exits nonzero
   while any fails), and, only when no test can observe the task's behavior (a prose-only or
   config-only change), an empty `tests` with `untestable` saying why. Roast checks that claim.

## Rules

- Write only tests and test fixtures. brewery reverts anything else you change.
- Do not write tests for other tasks. Later tasks get their own test step.
- Do not mock the unit under test, assert private calls or call order, or query storage
  when the public seam can read the result back.
- A criterion that no test at this task's seam can express is a defect in the brief. Return
  `BLOCKED` naming the criterion. Do not guess.

## Escalation

When the same task's test step has run `escalateAfter` times (default 2) without producing
tests that pass the red check and Roast, brewery runs it on the escalation agent (default
Opus) with the earlier evidence. An interactive Pick does the same: it dispatches
`brewery:test-writer` again with `model: opus` and the failure summary in the briefing.
