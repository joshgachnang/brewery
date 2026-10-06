---
name: barrel
description: Take a signed-off IP (from `distill`) all the way to a merge-ready PR without supervision. Loops terreno Pick and Roast across every task until the feature is done, runs Brew to open the PR, then hands off to `finish` until the PR is conflict-free with passing CI. Reaches the human over Slack, text, or email only for genuine decisions. Use when asked to barrel, build, or run an approved plan end to end; not for planning or merging.
---

# Barrel — approved IP to green PR

The outer loop. It owns persistence, recovery, and when to ask the human. The stages own
how each step is done:

| Phase | Follow | Loop |
| --- | --- | --- |
| Build | [`stages/pick.md`](stages/pick.md), which proves each task with [`stages/roast.md`](stages/roast.md) | every task until all have Roast `PASS` |
| Submit | [`stages/brew.md`](stages/brew.md) | until Brew `PASS` |
| Finish | the `finish` skill | until the PR is conflict-free with green CI |

Read [`lifecycle contract`](../terreno-shared/lifecycle-contract.md),
[`pick-roast loop`](../terreno-shared/pick-roast-loop.md),
[`subagent briefing`](../terreno-shared/subagent-briefing.md), and
[`reaching the human`](../terreno-shared/reaching-the-human.md). Execution state conforms
to [`execution-state.schema.json`](../terreno-shared/execution-state.schema.json) and
keeps a `ledger`.

## Run it with brewery

`brewery barrel <slug>` runs this as separate agent processes (Claude, Codex, or local models via
litellm). Every Pick, every Roast, the branch review, and Brew run in a fresh
process, and brewery commits between them, so Roast judges a fixed tree. Ready tasks run in
isolated worktrees up to `limits.parallelTasks` (`--parallel N` for one run), then land serially
after Roast PASS; dependencies must already have landed. Source: `tools/brewery/`. Use this skill directly for an
interactive, single-session run.

## Preconditions

- The IP's Sign-off section says `approved`. If it says `draft` or `awaiting sign-off`,
  stop and say so. Never approve it yourself, and never run `distill` from here.
- Open questions in the IP are settled by their recommendations. Build on them. Do not
  re-ask them.
- Work on a feature branch named after the IP slug. Create it from the latest base when on
  `master` or `main`.

## Drive

1. **Reconstruct** from the IP and `.terreno/pipeline/<slug>.json`: the next incomplete
   task, the last result, the head, and any "Prior human answers" preamble. Resume where
   state says. Never redo Roast-passed work.
2. **Build.** When driven by brewery, schedule ready tasks whose dependencies have landed,
   up to `limits.parallelTasks` (`--parallel 1` for sequential builds). Each task gets its
   own worktree and separate Pick/Roast processes; land passed commits one at a time.
   Abort landing conflicts and rebuild from the new head within `pickAttempts`. On a gate,
   start nothing new, drain running siblings, and persist only the first gate before exiting.
   Resume crashed `running` tasks by discarding their partial worktrees and returning them
   to `todo`. The bounded agent steps return to brewery; they never start another task.
   For an interactive run, follow `stages/pick.md` from the next incomplete task. Pick implements one
   task, proves it with `stages/roast.md` in a fresh subagent given the task-scoped
   briefing, commits after Roast `PASS`, and continues to the next task on its own.
   Append a ledger entry after every Pick and Roast result.
   - Roast `FAIL` → Pick retries the same task with the exact evidence.
   - Pick exits `FAIL` with a new hypothesis → start Pick again, fresh, from state.
   - Two failures on the same task and stage with no new hypothesis → classify the
     blocker honestly (see Human gates). Do not loop on the same approach.
   - Context getting long → finish the current task's commit, then start Pick fresh
     from state. State is durable, so nothing is lost.
   - Inner-loop `PASS` with every task Roast-passed → Submit.
3. **Submit.** Follow `stages/brew.md`. On `FAIL`, route by its `next`: `pick` (back to
   Build with the evidence), `roast` (reprove the named task), or `brew` (submission-only
   retry). On `PASS` or `PENDING` with `next: taste` → Finish.
4. **Finish.** Invoke the `finish` skill with the PR number and the state path. It loops
   Taste until the PR is conflict-free with passing CI on every host, or it blocks.
5. **Report.** Once, at the end:
   `PASS — <n>/<n> tasks Roast-verified, PR #<pr> conflict-free with green CI.`
   Then list the completed tasks, the Roast failures found and how each was fixed, the
   checks and artifacts, Open-question recommendations the build relied on, review
   threads still waiting on a human, residual risk, and PR deployment URLs. Send the
   headline through [`reaching the human`](../terreno-shared/reaching-the-human.md) as a
   notice, not a question.

Do not narrate each cycle. The ledger holds it.

## Human gates

Stop and reach the human only for:

- product semantics or acceptance criteria the IP does not settle
- architecture, security, PHI, data-ownership, or public-compatibility choices
- destructive or irreversible operations
- material scope growth. Offer it as an Expansion; do not build it.
- credentials or permissions the human must grant

Send it per [`reaching the human`](../terreno-shared/reaching-the-human.md): state (task
k of n, head, PR), what happened, why evidence cannot decide it, 2–4 options with
impact, the recommendation, and one question. Emit `BLOCKED` with `ask`, persist state,
and stop. On resume, the answer arrives as the preamble or a pasted reply, and step 1
picks up from state.

Test failures, lint, Roast findings, CI failures, and conflicts are engineering work, not
gates, while a concrete safe action remains. Environment or access blockers get a safe
remediation or a bounded retry first. Report them as non-human blocks, not questions.

## Never

- merge the PR, approve your own plan, or build Expansions
- push during Build (Brew pushes; `finish` pushes after that)
- commit execution state, add AI attribution, or use conventional-commit prefixes
