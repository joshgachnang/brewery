# Behavior-first tests

Tests are executable specifications at public seams. A refactor may replace the implementation without changing the test.

## Choose the seam

Before each slice, record the public seam in the task/working notes:

- HTTP route for backend behavior
- exported class/function for package behavior
- rendered component interaction for UI behavior
- injected adapter contract for external systems

Prefer the highest existing seam that proves the behavior. Add a seam only when the production design needs one.

## Red flags

- asserting private methods, internal call order, or call counts
- querying storage directly when the public interface can retrieve the result
- recomputing the expected value with the same algorithm as production
- writing tests for later tasks, or for behavior the task's criteria do not ask for
- deriving tests from the implementation instead of the task's brief
- testing a mock's behavior instead of the product behavior

Expected values come from a literal worked example, the IP, or another independent source of truth.

## Tests first, per task

Every test for a task is written before that task's implementation, from its test brief
(see the distill skill's task format), then confirmed red: each fails for the reason its
case describes. The implementation then works against the whole set. Tests are written one
task at a time, never for the whole IP up front, because later tasks build on seams earlier
ones create. Under `brewery barrel` a separate `test` step writes them and brewery checks red
and green itself; see [`../barrel/stages/test.md`](../barrel/stages/test.md).

## Planned e2e specs

The IP's `## E2E tests` table is the e2e plan, defined in the
[`testing plan`](testing-plan.md). Pick writes every row whose
`Written in` names the current task, in that task, at the row's path. Follow the e2e
guide the testing plan resolves for where specs live, how they find elements, and how
they wait. A row whose path or layer no longer fits is edited in the IP with a one-line
reason, never skipped. Running a layer the current stage cannot reach follows the
testing-plan deferral rule.

## Blast radius

A task that changes state can break behavior it never touches: every screen, query, or job
that reads that state. Distill traces these when it writes the task:

1. Start from the mutation (what the task writes, deletes, or changes the meaning of).
2. List its callers, and the consumers whose result depends on the changed state.
3. Keep only consumers a real user path reaches.
4. A consumer whose dependency is entirely backend logic gets a backend case in that
   consumer's existing suite. A missing case there is the gap, not e2e work.
5. A user-observable consumer gets an e2e regression case, run in the integrated roast.

E2e regression specs arrange state through the API and act through the UI: only the behavior
under test goes through screens, so one broken form does not fail every spec that needed its
record. Seed the world a spec only reads once per run. Create the subject it mutates on every
attempt and reconcile it before reuse, so the spec is retry-safe and owns its starting state.
Use the lowest-fidelity setup path that is indistinguishable from a production-created record
in everything the test, or a later spec in the same shard, can observe.

## Test tiers

| Tier | Examples | Runs in |
| --- | --- | --- |
| Fast | lint, typecheck, unit, integration, component, HTTP route tests | Pick, per-task Roast, review fixes, pre-push gates |
| Slow | e2e, Playwright and other browser suites, launched-app UI verification | integrated Roast once all tasks land, and product CI |

Per-task steps never run the slow tier. A browser-only criterion is deferred to the
integrated Roast, not failed. A task may still write or change an e2e spec; the per-task
check is that it typechecks.

## Repository composition

Load applicable repository testing skills before choosing commands, harnesses, fixtures,
databases, assertion libraries, or runtime probes. In Terreno apps those are
`terreno-backend-tests`, `terreno-frontend-tests`, and `terreno-mobile-tests`; run
`terreno-test-setup` first when the layer has no test setup. Match established tests near the
changed public seam. The lifecycle plugin does not prescribe a framework or package
layout.
