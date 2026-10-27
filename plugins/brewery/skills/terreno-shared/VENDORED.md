# Vendored terreno planning files

Not a skill (no `SKILL.md`). Shared references for `distill`, `cut`, `tap`, `pour`, `barrel`,
and `finish`.

Copied from [TerrenoLabs/terreno](https://github.com/TerrenoLabs/terreno) at `d8fdd897`
(plugin `terreno` 2.12.0, `plugins/terreno-claude/`), then resynced with terreno's
push-ownership change (`push-ownership.md` added; Taste, Brew, async-review-bots,
lifecycle-contract, and pick-roast-loop updated).

Last racked from terreno branch `user-guide` at `a5e53d0c` (plugin `terreno` 2.14.0), which
sits on `e2e-and-regression-testing` (`09af834c`) and is **not yet on master**. That rack
added `testing-plan.md` (required `## E2E tests` and `## Regression cases`, regression kept
minimal) and `user-guide.md` (required `## User guide`, with a `none` opt-out), updated
`documentation-contract.md` and `github-attention-contract.md`, and reapplied the Pick, Roast,
Brew, and Taste changes to the forks. Re-rack against master once both terreno PRs merge.
Skipped: `backfill-regression` and `backfill-user-guide` (operator tools brewery does not run;
use terreno's), and `loop-engineering.md` (terreno-internal explanation no brewery skill links).

| Here | Upstream | Changes |
| --- | --- | --- |
| `*.md`, `*.json` in this directory | `references/` | none, except below |
| `github-attention-contract.md` | `references/` | approval-ready body rules (exact headings, plan path and task ids in `Why`, status-marked rows, `ip` kept) from TerrenoLabs/terreno#1635 (open) |
| `lifecycle-contract.md`, `pick-roast-loop.md` | `references/` | `push-ownership.md` references are links |
| `subagent-briefing.md` | `references/` | per-task Roast spawns no UI/runtime verifier; the integrated Roast spawns at most one |
| `mocking.md` | `skills/2-pick/references/` | none |
| `testing.md` | `skills/2-pick/references/testing.md` | tests first per task (replaces the "all imagined tests" red flag), blast radius, test tiers; the Terreno testing-skills line from TerrenoLabs/terreno#1614 (open); "Planned e2e specs" links `testing-plan.md` in this directory |
| `../barrel/stages/pick.md` | `skills/2-pick/SKILL.md` | frontmatter dropped, links, Roast is followed from `roast.md`, steps 5–7 write all of the task's tests first through `test.md` |
| `../barrel/stages/roast.md` | `skills/3-roast/SKILL.md` | frontmatter dropped, links, step 3 checks the tests against the task's test brief and returns `retest`; per-task Roast runs `http`/`process` e2e rows and defers `browser`/`native flow` rows to the integrated Roast |
| `../barrel/stages/brew.md` | `skills/4-brew/SKILL.md` | frontmatter dropped, links, hand-off goes to `finish` |
| `../finish/taste.md` | `skills/5-taste/SKILL.md` | frontmatter dropped, links, `finish` owns the repeat loop |
| `../distill/references/distilling.md` | `skills/1-grow/references/grilling.md` | rewritten: triage instead of full grilling |

Only `reaching-the-human.md` is original to this directory. `../barrel/stages/test.md` and
`../../../agents/` (`test-writer`, `test-runner`) are original to brewery.

Upstream terreno Pick does red-green one test at a time and forbids batching the tests
first. brewery writes every test for a task first, in a separate context that never sees
the implementation, so its tests come from the task's brief rather than its code.

Name mapping: lifecycle docs say Grow/Pick/Roast/Brew/Taste and `terreno-*-loop`. Here Grow
is `distill`, the Pick→Brew outer loop is `barrel`, and Taste-until-green is `finish`.
Stage results still use the upstream `stage` enum (`grow`, `pick`, `roast`, `brew`, `taste`)
so zerg and other terreno tooling can read them.

To resync, run the [`rack`](../rack/SKILL.md) skill: it diffs upstream from the SHA above
and reapplies the Changes column.
