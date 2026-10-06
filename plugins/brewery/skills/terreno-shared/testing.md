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
- writing all imagined tests before any implementation
- testing a mock's behavior instead of the product behavior

Expected values come from a literal worked example, the IP, or another independent source of truth.

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
databases, assertion libraries, or runtime probes. Match established tests near the
changed public seam. The lifecycle plugin does not prescribe a framework or package
layout.
