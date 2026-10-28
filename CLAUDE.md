# brewery

Agent skills (`plugins/brewery/skills/`) and the `brewery` CLI (`cli/`). Run
`cd cli && bun install && bun test && bun run typecheck` before pushing. Skill text is
guarded by `cli/test/layout.test.ts`. Vendored terreno files live in
`plugins/brewery/skills/terreno-shared/`; resync them with the `rack` skill, never by hand.

## Keep the docs and installer current

The README is how a newcomer learns the whole pipeline, and the `install` and `overview`
skills are how an agent sets brewery up and picks a skill. Update them in the same change
as the thing they describe, never in a follow-up:

| When you… | Also update |
| --- | --- |
| Add, rename, or remove a skill | README (a bold one-liner + `<details>`, and the Skills table), `overview` (the "Pick one" table), `install` if setup changes, and the descriptions in `plugins/brewery/{.claude,.cursor,.codex}-plugin/plugin.json` and the three marketplaces |
| Add, rename, or remove a CLI command or flag | `HELP` in `cli/src/cli.ts`, `cli/README.md`, and the README's CLI table |
| Change a pipeline stage's behavior, a gate, or a reply | The stage's README section and `overview` |
| Add a prerequisite, install step, or config key a new user must set | `bin/install` if it can do it, the `install` skill, and the README's Install section |
| Change any skill or agent text | Bump `version` in the three plugin manifests and the marketplaces that carry one |

README style: each part opens with one short bold sentence, and the detail goes in a
collapsed `<details>` block (blank line after `</summary>`). Keep the top screen to a
sentence, the diagram, and the quickstart. Depth belongs in `cli/README.md` and
`docs/approve.md`; link to it rather than copying it.

`cli/test/layout.test.ts` fails when a skill is missing from the README or `overview`, when
a CLI command is missing from the README or `HELP`, or when manifest versions differ.

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
