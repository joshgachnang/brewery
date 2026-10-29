# Approval-ready — pass the approval agent before you push

Original to brewery. `brewery approve` (the **terreno-approval-agent** App, see
[`docs/approve.md`](../../../../../docs/approve.md)) judges every PR head on four
dimensions, scored 0–3: plan match, architecture, tests, and evidence. It approves only a
`low` PR with no blocking finding and every gate clean. barrel, tap, and pour run the same
checks on their own branch first, so the PR reaches the bot already passing. Fix what you
find through Pick and Roast; never weaken the check to make it pass.

Run this at three points:

| When | What |
| --- | --- |
| Pick step 10 (drift) | Plan match and Architecture on this task's patch |
| Roast step 3 (matrix) | The Tests bar on this task's tests |
| Brew step 3, before the push | All four dimensions on the whole branch, plus the body and the gates |

## Load the rubric the bot uses

The bot reads its rubric from the **base branch**, so read it from there too:

1. `approve.rubric` in `.brewery.json` on the base (default `docs/approval-rubric.md`):
   `git show origin/<base>:<path>`.
2. No such file → brewery's default:
   `gh api repos/joshgachnang/brewery/contents/cli/templates/approval-rubric.md -H "Accept: application/vnd.github.raw"`.

Apply that file as written. Repository rules (Terreno's `APIError`, `findExactlyOne`,
`@terreno/ui`, coverage gates, generated SDKs, changelog fragments) live in the repo's
rubric, not here. Its **Blocking findings** list is must-fix. Its **Signals that move the
level** list is what to avoid.

## Plan match

The bot's plan judge sees only the plan, the claimed task ids, and the diff.

- Always have a plan. barrel and pour build from an approved IP; tap writes a fix IP. All
  live in a directory the bot searches (`approve.planDirs`, default `docs/plans`,
  `docs/implementationPlans`, `docs/tasks`). A PR the bot cannot tie to a plan scores at
  most 1.
- The diff delivers every claimed task's behavior and acceptance criteria. A missing one
  goes back to Pick.
- Nothing unrequested. A refactor, cleanup, or extra feature no task names is drift, even
  when it is good: revert it or park it as an Expansion. Tests and docs for claimed work
  are not drift.
- Every acceptance criterion's named verification method (test, probe, artifact) exists in
  the diff or the PR evidence.
- Do not edit the plan to match the code. That raises the floor to medium. When the plan
  must change, explain why in `Why`.

## Architecture

- Every rule in the rubric's Architecture, Security, Dependencies, and Changelog sections
  holds for the diff. Load the repository docs and skills each rule names for the touched
  packages.
- Generated files are regenerated, never hand-edited, and ship with the change that
  generates them.
- No duplicate of an existing helper. Sibling layers follow through (model → interface →
  OpenAPI → SDK, scaffold, templates, docs).
- No `TODO`, `FIXME`, commented-out code, or new explicit `any`.
- A new runtime dependency is named in the PR body with its reason.
- A change to published behavior carries the repo's changelog entry or fragment. A
  user-visible or architectural change updates its docs in the same PR.
- Never touch a file the bot's `pathRules` mark `never` (CI config, `.brewery.json`, the
  rubric) unless the IP asks for it. A version bump is release work: not in a feature PR.

## Tests

- Every new branch of logic has a test that fails without it. brewery's tests-first steps
  already prove this per task. The Brew check confirms nothing slipped in after Roast.
- No test deleted, skipped, `.only`'d, or weakened. A changed expected value has its
  reason in the commit.
- Snapshot updates are explained in the PR body.
- The repository's coverage gate, when it has one, runs green locally (the rubric or the
  repo's `CLAUDE.md` names the command).
- A test that asserts the bug is a blocking finding.

## Evidence

The PR body follows the [GitHub attention contract](../../terreno-shared/github-attention-contract.md).
The bot reads it as a claim and credits a row only when the diff, the checks, or an
attached artifact backs it.

- Headings spelled exactly `## Why`, `## What changed`, `## Verification`.
- `Why` ends with the plan path in backticks and the task ids (`` Implements `docs/plans/2026-10-29-x.md` (T1–T3). ``),
  plus `Closes #<n>` for each fixed issue.
- The Verification table has `✅`, `🧭`, or `⚠️` in the first cell of every row, and each
  `✅` row has its outcome next to its command (`` `bun test` → 412 pass ``).
- Every `⚠️ Not tested` row names the blocked behavior and the exact steps a reviewer
  follows to check it. A bare `⚠️` row keeps the PR off `low`.
- A UI change embeds a screenshot or video of the changed screen.
- The stage-result block keeps `ip` and the delivered task ids.

## Gates the bot enforces in code

These block approval whatever the score, so check them before the push:

- the diff under `approve.maxLines` and `approve.maxFiles` (default 800 lines, 40 files).
  Over it, say so in the PR body; do not split a roasted feature to dodge it.
- no `never` file in the diff
- no blocking finding from the rubric's list

After the push, `finish` covers the rest: green CI on the head and every bot thread
answered.

## When you cannot get there

Some PRs are medium or high by nature (auth, migrations, infra). The goal is not `low`. It
is a PR that scores 3 on every dimension the change can reach, so the human reviews risk,
not missing work. Record each gap you could not close, with its reason, in the
`Verification` table as a `⚠️` row with reviewer steps.
