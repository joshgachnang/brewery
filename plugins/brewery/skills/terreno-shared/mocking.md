# Mocking at boundaries

Mock only a boundary where production leaves the system:

- third-party APIs and provider SDKs
- time, randomness, or operating-system I/O
- network transport
- file storage when a real temporary directory is unsuitable

Use real internal collaborators and integrations when the repository's test environment
supports them. Repository skills decide whether databases, stores, routers, or framework
harnesses are real, isolated, or replaced at a boundary.

## Prefer injected fakes

Pass a narrow, domain-specific adapter into production code and provide a local fake in the test. Each adapter operation should have one typed purpose and one response shape.

Keep fake state inside the test or a fresh harness factory. Assert observable results first; inspect fake state only when the boundary interaction itself is the contract.

## Module mocks leak

Some runners implement module mocks as process-wide or hoisted state. Registration may
survive an individual test and make order significant. Consult repository test guidance.

Design an injectable seam instead of using `mock.module`. When an unchangeable dynamic import makes a module mock unavoidable:

1. isolate it in a dedicated file or test process
2. document why dependency injection cannot represent the boundary
3. run it through the repository's isolated-test mechanism
4. never rely on restoring the module in `afterEach`

## Scoped spies

A test-local `spyOn` is acceptable for a true boundary or for forcing an otherwise unreachable framework error. Restore it in the same test lifecycle. A spy on an internal collaborator is not a substitute for testing public behavior.
