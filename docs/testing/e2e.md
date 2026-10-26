# E2E testing guide

brewery has one e2e layer: `process`. There is no browser, device, or server layer.

| Layer | Where specs live | How they run the code | How they wait | Command |
| --- | --- | --- | --- | --- |
| `process` | `cli/test/*.test.ts` | Call the CLI commands against a temp git repository with the fake agent in `cli/test/fixtures/fake-agent.ts` | Await the command's promise; never sleep | `cd cli && bun test` |

Skill text has no runtime, so `cli/test/layout.test.ts` is the proof that each skill carries
its contract phrases (required IP sections, cut's blocking rules, the opt-outs). A skill
change that adds a required phrase adds a case there.

Manual cases a person walks live in [`docs/regression/`](../regression/).
