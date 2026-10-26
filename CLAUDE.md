# brewery

Agent skills (`plugins/brewery/skills/`) and the `brewery` CLI (`cli/`). Run
`cd cli && bun install && bun test && bun run typecheck` before pushing. Skill text is
guarded by `cli/test/layout.test.ts`. Vendored terreno files live in
`plugins/brewery/skills/terreno-shared/`; resync them with the `rack` skill, never by hand.

## Testing conventions

brewery has no browser or device layer. Its e2e tests are the CLI's `bun test` suites,
which drive whole commands against fake agents and temp git repositories.

| Key | Value |
| --- | --- |
| E2E guide | docs/testing/e2e.md |
| Regression suites | docs/regression/ |
| Smoke command | cd cli && bun test |

## User guide conventions

| Key | Value |
| --- | --- |
| User guide | none — CLI and agent skills with no in-app users |
