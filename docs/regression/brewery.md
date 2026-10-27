# Brewery regression suite

Area: BREW
Owner: Josh
Last full run: never

| ID | Case | Steps | Expected | Platforms | Automated by | Added |
| --- | --- | --- | --- | --- | --- | --- |
| BREW-001 | Distill plans e2e, regression, and user guide sections | In a scratch repo that has `docs/testing/e2e.md` and no `## User guide conventions` table, run `distill` in Claude Code on "add a due date to todos". Then delete `## User guide` from the draft and run `cut` | The IP carries `## E2E tests`, `## Regression cases` (usually `None — no hard-to-automate change`), and `## User guide` with a page row for the due date. `cut` reports the missing `## User guide` as blocking | Claude Code | cli/test/layout.test.ts (text only) | e2e-and-regression-testing |
| BREW-002 | Recipe writes nothing to Linear before the preview is confirmed | In a repository with Linear access (MCP or `LINEAR_API_KEY`), run `recipe "<a small user-facing feature>"` in Claude Code and answer `Change something` at the preview; then run it again and answer `Create it in Linear` | After the first answer the Linear workspace has no new project, milestone, issue, initiative, or label, and `.terreno/recipe/<slug>.json` holds the draft. After the second, the project exists with one issue per milestone, every field in the preview matches with its evidence, the description ends with Open questions, Expansions, Decisions, and Links, and the report carries the design brief or design link | Claude Code | cli/test/layout.test.ts (text only) | recipe |
