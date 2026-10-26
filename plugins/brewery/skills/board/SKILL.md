---
name: board
description: >-
  Show one repo's brewery board: what is in progress, what is blocked (on the human or on
  unlanded dependencies), the tasks that are ready next, and recent merges, read from the
  IPs in docs/plans, run state under .terreno/brewery, open PRs, and merge history. Use
  when asked what's on the board, what's next, what's blocked or in flight, or what
  shipped lately; read-only, never starts or changes a run.
---

# Board

Read-only. Report the board; do not pick, answer gates, or edit IPs.

## With the CLI

Run `brewery board` from the repo (`--repo <dir>` elsewhere, `--merges N` for a longer
history, `--json` to reason over it). Relay its four sections as they are, then add at most
one line naming the thing that most needs the human, usually the oldest `waiting on you`
item and its `brewery answer` command.

## Without it

Build the same board by hand:

- **Plans:** every `.md` in `docs/plans`, `docs/implementationPlans`, and `docs/tasks` with a
  `Status:` line or `- [ ] **T<n>** — …` task rows. Plans whose tasks are all `[x]` and that
  have no live run are done; count them, don't list them. Plans with neither are not brewery
  IPs; skip them.
- **Runs:** `.terreno/brewery/<slug>/state.json` whose `ip` is that plan and `phase` is not
  `done`. A task `passed` or `skipped` there has landed even when the main tree's checkbox
  is still empty.
- **Blocked:** a run with `waiting` (quote the first line of its message and
  `brewery answer <slug> "<reply>"`), a plan whose Status is not `approved …`, and any open
  task whose `Depends on:` names a task that has not landed. A task with no `Depends on:`
  depends on the one before it.
- **In progress:** runs past `approved` (phase, landed/total, running task ids, PR), and open
  PRs (`gh pr list --state open`) whose branch no run owns.
- **Next up:** open tasks in approved plans whose dependencies have all landed and that are
  not running, oldest plan first.
- **Recent merges:** `gh pr list --state merged --limit 10`, or offline
  `git log --first-parent -10 origin/<base>`.
