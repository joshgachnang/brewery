# Brewery regression suite

Area: BREW
Owner: Josh
Last full run: never

| ID | Case | Steps | Expected | Platforms | Automated by | Added |
| --- | --- | --- | --- | --- | --- | --- |
| BREW-001 | Distill plans e2e, regression, and user guide sections | In a scratch repo that has `docs/testing/e2e.md` and no `## User guide conventions` table, run `distill` in Claude Code on "add a due date to todos". Then delete `## User guide` from the draft and run `cut` | The IP carries `## E2E tests`, `## Regression cases` (usually `None — no hard-to-automate change`), and `## User guide` with a page row for the due date. `cut` reports the missing `## User guide` as blocking | Claude Code | cli/test/layout.test.ts (text only) | e2e-and-regression-testing |
