# brewery

Plan and ship a feature with a separate agent process for every step. It uses the
`distill`, `cut`, `barrel`, and `finish` skills in `plugins/brewery/skills/` for method. brewery
owns sequencing, commits, CI waits, limits, and every contact with the human.

```text
brewery distill "<request>"      claude writes the IP ─┐
                                  cut: claude + codex attack it (clean worktree, only your words)
                                  claude fixes the findings (≤2 rounds)
                                  → sign-off message, ntfy ping, exit 3
brewery pour "<request>"         distill + cut as above → no fundamental question and ≤ pourMaxTasks tasks? brewery approves it
                                  and goes straight into barrel and finish; otherwise sign-off, then the same
brewery answer <slug> "ok, 2b"   apply the reply → validate/repair task graph → Status: approved or ask again
brewery barrel <slug>            ready tasks (up to parallelTasks), each: create worktree → setup → sonnet writes the task's tests
                                    → brewery confirms them red → commit → claude picks → brewery confirms green → amend → claude roasts
                                    (FAIL → pick again with evidence, amend the worktree commit; FAIL with retest → tests first)
                                    PASS → cherry-pick onto feature branch → tick checkbox and amend → remove worktree
                                  if tasks overlapped: integrated roast → repair and commit → roast again
                                  branch review: claude + codex in parallel → fix blocking findings
                                  brew: claude opens the PR
                                  finish: gh waits (no tokens) → claude tastes each red snapshot or unanswered bot thread
                                  → PR conflict-free, green, bot comments answered, exit 0
                                  (still red after 3 fix rounds → BLOCKED gate to the human)
```

## Install

```bash
~/src/brewery/bin/install    # bun install, and links ~/bin/brewery to cli/src/cli.ts
brewery agents               # what is available, how stages route
```

Run from the checkout, brewery finds its skills in `plugins/brewery/skills`. A repo that
vendors its own (`<repo>/.claude/skills/distill`) uses those, and `BREWERY_SKILLS_DIR` overrides
both (the zerg image sets it). `bun run compile` builds a standalone binary, which falls back
to `~/.claude/skills`.

## Agents and routing

Profiles are `claude` (`claude -p`), `codex` (`codex exec`), `cursor` (Cursor's `agent -p
--force --trust`; set `bin` to `cursor-agent` on older installs and `CURSOR_API_KEY` to log
in), or `command` (any argv, with the prompt on stdin). Cursor's CLI takes its prompt as an
argument, so brewery passes it a one-line pointer to the prompt file. It has no read-only
mode, so `approve` and `calibrate` must stay on claude. An escalation agent that is not
installed falls back to the stage's own route with a note. Local models run through codex with a custom provider pointed at
the litellm gateway, so they get a real tool-using harness:

```json
{
  "agents": {
    "local": {
      "type": "codex",
      "model": "deepseek-v4",
      "provider": { "name": "litellm", "baseUrl": "http://100.76.70.90:4000/v1", "envKey": "LITELLM_API_KEY" }
    },
    "opus": { "type": "claude", "model": "opus" }
  },
  "stages": { "pick": ["codex"], "roast": ["claude", "local"], "cut": ["claude", "codex", "local"] },
  "notify": { "ntfyUrl": "https://ntfy.sh/<topic>" },
  "worktreeSetup": ["bun bootstrap"],
  "limits": { "pickAttempts": 3, "parallelTasks": 3, "finishPushes": 3, "finishHours": 4 }
}
```

Put it in `~/.config/brewery/config.json`, or `<repo>/.brewery.json` per repo. Override a
single run with `--agents pick=claude,roast=claude+codex`.

Each ready task builds in `.terreno/brewery/<slug>/worktrees/<id>` on local branch
`brewery/<slug>/<id>`, starting from the feature branch's current head. Pick and Roast
read the IP and repository skills in that worktree. Before each task's asynchronous
startup, brewery captures the approved IP text with the current completion marks and
writes that snapshot into its new task tree, including rebuilds. This preserves
approval edits for tracked and untracked IPs while
sibling tasks land. Step logs and run state remain in
the main tree. After Roast passes, brewery cherry-picks the task commit, checks its IP
box inside that landed commit, records the landed SHA, and removes the worktree and
local branch. Retries after Roast failures amend the same worktree commit. Gated tasks
retain their worktree and commit for a later retry; skipping a task removes that tree.
Cut and failure-path cleanup is best effort: a removal or branch deletion failure logs a
cleanup warning and preserves the original findings, error, or setup evidence. Failed
setup trees are never passed to Pick; cleanup retries consume the bounded attempt
allowance and gate with the setup evidence if cleanup remains unsuccessful. Retained
task paths stay in state for later cleanup. Cleanup after a successful land remains
strict, so a failure stops the run with the landed commit recorded.

| Config | Default | Behavior |
| --- | --- | --- |
| `worktreeSetup` | `[]` | Shell commands run in order in each fresh task worktree, before Pick. Shade uses `["bun bootstrap"]`. A nonzero exit records stdout/stderr as failure evidence, removes the tree, and consumes a Pick attempt. |
| `limits.parallelTasks` | `3` | Maximum concurrent task builds. `--parallel N` overrides it for one run; `--parallel 1` runs sequentially. |
| `limits.testFirst` | `true` | Run the `test` step (default agent `claude-sonnet`) before each task's Pick. `false` returns to Pick writing its own tests. |
| `limits.pourMaxTasks` | `6` | The most tasks `brewery pour` approves without asking you. |
| `limits.escalateAfter` | `2` | Runs of a task's `test` or `pick` step before the next one uses `escalate[stage]`. |
| `escalate` | `{"test": ["claude-opus"], "pick": ["claude-opus"]}` | Stronger agents per stage for steps that keep failing. A repo's map replaces this one wholesale; `{}` turns escalation off. |

## Parallel builds

Declare `Depends on: none` or `Depends on: T1, T3` in each task's details. A missing
line depends on the previous task, so older IPs retain their sequential order. Task IDs
must be unique across all rows, including completed tasks. Duplicate IDs produce
`Duplicate task id: T1` findings; barrel rejects the graph before starting any task.
Tasks become ready only when all dependencies have landed; an explicitly skipped dependency
also releases its dependants. Ready tasks start in IP order up to `limits.parallelTasks`,
except that a ready task waits while a running task declares a shared `Files:` entry.
Each runs Pick and Roast in its own worktree, and a single serial queue lands passed
task commits on the feature branch. Dependencies therefore start with their parents'
landed commits and checked IP entries already present.

```bash
brewery barrel my-feature --parallel 2 --no-wait
```

If landing conflicts, brewery aborts the cherry-pick, records the conflicting paths and
the earlier tasks that touched them, removes the worktree, and rebuilds from the new
branch head. This consumes another Pick attempt and remains bounded by `pickAttempts`.
Differences consisting only of IP checkboxes are reconciled during landing.

The first BLOCKED or stuck task stops new starts. Running siblings finish and land;
the first gate is saved in `state.waiting`, later gated siblings reset to `todo`, and
an unattended CLI run exits 3. The first gated task retains its tree for an explicit
retry. After a crash, tasks persisted as `running` lose their partial worktrees and
commits and return to `todo`, keeping their consumed attempt count. A durable landing journal restores the pre-land
branch head and approved IP after an interrupted cherry-pick, before rebuilding. `brewery status`
shows active tasks, for example `running T2, T3`. Step artifacts carry unique sequence
numbers and task ids in the main tree.

After all tasks land, every run enters the persisted `integrate` phase before branch
review. `roast INTEGRATE` uses `stages.roast` fan-out to prove every task's acceptance
criteria on the combined HEAD and run the repository's full test command. It is the only
step that runs e2e and browser suites; per-task Pick and Roast, and review fixes, run
lint, typecheck, and unit/integration tests only.

A failure passes pooled evidence to `pick INTEGRATE` in the main tree. Brewery commits
repairs as `Fix integration of parallel tasks` before roasting the combined tree again.
Repair attempts use a separate persisted `integrationRounds` counter, bounded by
`limits.reviewRounds`; branch review keeps its own full allowance. Exhaustion gates
with `retry` / `ship` / `stop`: retry resets integration's allowance, ship proceeds to
branch review, and stop preserves the phase for later resumption. A BLOCKED integration
step gates immediately without starting review. Retained repair edits are committed
before a resumed Roast or a `ship` reply advances to branch review.

`cut`, `roast`, and `review` fan out. Every listed agent runs, and a FAIL from any one of
them fails the step. Other stages use the first available agent. An unavailable agent
(missing binary, unset key) is skipped with a note.

## What is enforced, and how

| Rule | Mechanism |
| --- | --- |
| Separate agents per step | Every step is a new `claude -p` / `codex exec` / `agent -p` process with a written prompt. |
| Cut sees only the human's words | Its prompt holds only `.terreno/brewery/<slug>/context.md` (your request and replies, verbatim), and it runs in a `git worktree` of HEAD where `.terreno/` does not exist. |
| Roast judges a fixed tree | brewery commits after Pick, before Roast. Retries amend the task's commit. |
| Tests come before code | With `limits.testFirst` (default), a `test` step writes each task's tests from its brief before Pick. brewery reverts any file it did not declare, runs its `command` and rejects tests that already pass, then commits them. After Pick, brewery reruns the command and rejects a red result or a change to those tests with no stated reason. |
| Stuck steps escalate | A task's test step or Pick that has run `limits.escalateAfter` times (default 2) runs next on `escalate[stage]` (default `claude-opus`). |
| No self-approval | brewery owns the IP's `Status:` line and resets one an agent approved. Only `brewery answer` approves, or `brewery pour` when brewery itself counts at most `pourMaxTasks` tasks and no `fundamental` question; it records that in the Status line. |
| Valid task graph before sign-off | Distill rejects drafts with duplicate task IDs, unknown dependencies, self-dependencies, or cycles. Cut/fix rechecks the graph after every edit and passes remaining problems as blocking decomposition findings, even when Cut found nothing. An invalid graph after `limits.cutRounds` throws before sign-off. |
| Valid task graph before approval | Answer validates the edited IP regardless of the agent's `structural` flag. Invalid graphs go through cut/fix as blocking decomposition findings. Unrepaired problems return to sign-off, with the problems listed; only a valid graph can be approved. |
| Progress can't be faked | brewery checks each task box only after a Roast PASS and cherry-pick onto the feature branch. |
| Bounded loops | Pick attempts per task, cut and review rounds, finish pushes and hours, and a "same failure twice" stop. |
| No tokens while waiting | brewery runs `gh pr checks --watch` itself and starts a Taste agent only on a red snapshot. |
| Privacy | ntfy pings carry no content. The full message prints to the terminal and is saved in state. |

For example, `T1` depending on `T2` while `T2` depends on `T1` produces the finding
`Dependency cycle: T1 → T2 → T1`. A fix must remove the cycle before sign-off can proceed.

## Human loop

When a run needs you, brewery prints one message (and an SMS-length version), pings ntfy,
saves the state, and exits with code 3. When you are at the terminal, it asks for the
reply right there instead. Reply from anywhere with `brewery answer <slug> "<reply>"`:

- sign-off: `ok`, `ok, 2b`, `no: <why>`, or answers without approval (applied, then asked again)
- gates: `1a`, `retry: <hint>`, `skip` (task), `ship` (integration or review), `stop`

`brewery status` lists runs and what is waiting on you. Each step's prompt, log, and result
are in `.terreno/brewery/<slug>/steps/`.

An approval reply runs at most one cut/fix round when the edit is structural or its
task graph is invalid. If repair leaves the IP unusable, the run stays at sign-off
and lists the remaining problems before the other questions. Reply again with repair
guidance, for example `brewery answer my-feature "no: T1 must depend on none"`.
Rejected plans and replies without approval use `limits.cutRounds` when repair is
needed. Processing keeps the saved sign-off until approval or a replacement sign-off
is persisted, so an interrupted step or cut error can be retried with `brewery answer`.

If a process stops during a step, run `brewery resume <slug> --go`. Brewery reads the
saved phase: it reruns distill with the saved request and notes, continues approved,
build, review, and brew runs through barrel, and continues finish through Taste. Passed
tasks stay passed. A run waiting for sign-off or a gate still needs `brewery answer`.

Review rounds persist whether they are still in progress and their blocking findings.
Resume reruns an interrupted round, including the final permitted round, before PR
submission. Exhausting the round limit permits submission only with a saved clean
outcome; unresolved findings or older state without an outcome reopen the review
gate. The human can retry or explicitly choose to ship at that gate.

Each active command writes `.terreno/brewery/<slug>/run.pid` with its process ID and
holds `run.lock` for the command's lifetime. A second run command for that slug exits
with an "already running" error. A killed process leaves stale markers; the next run
removes them when that PID is no longer alive. `brewery note` remains available during
a run because it uses the separate short-lived state lock.

To add guidance while a run is active, use `brewery note <slug> "<text>"`. Brewery keeps
the text in `state.notes`, appends it verbatim to `context.md` for cut, emits a `note`
event, and includes it in later step prompts. The note does not resume or interrupt the
current step; later steps apply it at the next sign-off or gate.

## Progress events

Each run appends one JSON object per line to `.terreno/brewery/<slug>/events.jsonl`.
Consumers can keep a byte offset and read only new lines. Every event has an ISO 8601
`t` timestamp and a `kind` field. The file stays outside git with the rest of the run
state.

| Kind | Fields | When emitted |
| --- | --- | --- |
| `step.start` | `seq`, `stage`, optional `task`, `agent` | Before an agent process starts |
| `step.end` | `seq`, `status`, `action`, `seconds` | After its result is read, including failed results |
| `narration` | `seq`, `text` | As Claude or Codex emits assistant text or starts a tool; one line, at most 300 characters |
| `waiting` | `waitingKind` (`signoff` or `gate`), `message`, optional `ip` | When brewery stops for a human answer |
| `resumed` | — | When brewery accepts an answer to a waiting run |
| `note` | `text` | When a human answer is recorded |
| `pr` | `number`, `url` | When brewery finds the run's PR |
| `ci` | `state` (`pending`, `fail`, or `pass`) | After each CI snapshot |
| `done` | — | When the PR is green and the run finishes |
| `error` | `message` | When a run command exits with an error |

For example, `{"t":"2026-09-28T12:00:00.000Z","kind":"step.start","seq":1,"stage":"distill","agent":"claude"}`
starts a step. Match its `seq` to the later `step.end`. Fan-out steps have a separate
sequence number per agent.

Claude runs with `--output-format stream-json --verbose`; Codex runs with `exec --json`.
The raw JSONL output remains in each step's `.log` file. Brewery reads complete stdout
lines as they arrive and appends `narration` events for assistant text and brief tool
summaries, such as `Read groupQueue.ts` or `Bash: bun test`. It ignores malformed lines,
tool output, and final result records. `command` profiles emit only step start and end.

## Approving pull requests: `brewery approve <pr>`

One head, one verdict, one review posted as the terreno-approval-agent GitHub App: `APPROVE` when
the risk level is one the repo allows, `COMMENT` otherwise, plus a `terreno/approve` check
run. Policy comes from the base branch's `.brewery.json` `approve` block and a rubric
markdown; path rules set floors and ceilings in code; a clean agent judges plan-backed PRs
against their plan; the rubric agent scores plan match, architecture, tests, and evidence;
code clamps the level, applies the gates, and decides. `--dry-run` prints the verdict and
body without posting. It runs inside the repo's CI (`templates/ci/circleci-approve.yml`,
`templates/ci/github-approve.yml`) with `--wait-checks`, which waits for every other check
on the head and skips a red or still-pending head without spending a model. Everything,
including the GitHub App's permissions and the rollout, is in
[`docs/approve.md`](../docs/approve.md).

## Learning the rubric from humans: `brewery calibrate <owner/name>`

One repo per call. It reads what humans said on PRs since the last pass (first pass: 30 days):
review verdicts, inline comments with their hunks, conversation comments, and what the
approval agent said about the same head. `--notes <file>` adds pasted comments or opinions;
`--reviewer a,b` keeps only those logins. The `calibrate` skill runs in a fresh worktree and
may edit only the rubric, `.brewery.json`, and `docs/learnings/`; brewery opens one PR. More
than 8 new rubric lines, or a change elsewhere, means no PR (exit 4). Rules true of any repo
come back as proposals for `cli/templates/approval-rubric.md`. `--dry-run` prints the evidence.

## Docs layout and learning

`brewery init-docs` adds the standard layout to a repo and points `AGENTS.md`/`CLAUDE.md` at it:

| Path | What |
| --- | --- |
| `docs/plans/`, `docs/specs/` | IPs and design specs (unchanged) |
| `docs/decisions/NNNN-<slug>.md` | Decisions that outlive a plan |
| `docs/journal/` | One generated journal per run |
| `docs/learnings/<category>/<slug>.md` | One learning per file, grep-able frontmatter (`TEMPLATE.md`) |
| `docs/learnings/RULES.md` | At most 15 active rules every stage reads |

At the first green of a brewery run, in a repo that has `docs/journal/`:
1. **compound** runs, but only if the run struggled: failed Pick/Roast attempts, branch-review fixes, CI
   failures fixed during finish, or a human reply beyond "ok"/"skip". It follows `compound/SKILL.md` and
   may write or update **one** file under `docs/learnings/`. brewery reverts anything else it touched,
   and keeps nothing if it wrote two.
2. brewery renders `docs/journal/YYYY-MM-DD-<slug>.md` from the run state: stages, tasks, human answers,
   CI failures with log tails, and the timeline.
3. Both are committed together and pushed once. finish then waits for green on the new head.
   If the push fails, the journal is left uncommitted.

Set `"phi": true` in a PHI repo's `.brewery.json` (the Flourish repos). Its journal then leaves out CI log
tails, which stay in the git-ignored run state. Compound and cellar are told not to quote log lines.

Every step's prompt includes the Active rules from `docs/learnings/RULES.md`. Distill also searches
`docs/learnings/` before shaping the plan. Set `"learn": "off"` in `.brewery.json` to skip compound.
The `compound` stage routes like any other (default: claude).

Run state also feeds learning:
- `finish` saves each failing check to `.terreno/brewery/<slug>/ci/NNN-<check>.json` before Taste reacts.
  Each file holds the scrubbed failed-step log tail. Once green it is marked `fixed` (with the fixing sha),
  or `flaky` if it passed at the same sha.
- Every state save also writes `.terreno/pipeline/<slug>.json` in the terreno execution-state shape,
  for the vendored skills and zerg.

A `D2 (durable)` row in an IP's Decisions table is copied to `docs/decisions/NNNN-<slug>.md` in the
same end-of-run commit, and the marker becomes a link.

## Nightly learning: `brewery cellar <owner/name>`

One repo per call. It gathers everything since that repo's last pass (first pass: 7 days):
- brewery journals that reached the default branch
- failed GitHub Actions runs, with the newest scrubbed failed-step log per workflow and branch
- merged PRs from any session: local, remote, web, or Cursor cloud

It skips the agent entirely when nothing happened. Otherwise the `cellar` skill runs in a fresh worktree
of the default branch and may:
- write or update learnings
- promote recurring ones to rules in `RULES.md`, or to checks
- retire stale rules

brewery then opens one PR. More than 3 rule or check changes in one pass means no PR (exit 4).
With `"learn": "shared"`, the PR also lists proposed changes to the brewery skills. `"off"` skips the repo.

The local checkout comes from `repos` in the user config (`{"repos": {"owner/name": "/path"}}`), or any
repo brewery has run in whose origin matches. If neither exists, it clones to a temp dir.
State is one stamp file per repo plus `cellar.log`, in `~/.local/state/brewery/cellar/`
(`BREWERY_CELLAR_DIR` overrides it). Runs for different repos can overlap.

Scheduling is up to the host: one line per repo, e.g. cron

```
0 3 * * * brewery cellar acme/widgets >> ~/.local/state/brewery/cellar/cron.log 2>&1
```

`--dry-run` prints the gathered evidence without calling an agent or moving the stamp.
`--since <ISO date>` overrides the window. Exit codes: 0 PR opened or nothing to do,
4 over the change limit, 1 error.

Design: `docs/specs/2026-10-12-brewery-docs-and-learning-loop-design.md`.

## Development

```bash
bun test          # unit + end-to-end flows against temp repos with a scripted fake agent
bun run typecheck
```

### Interrupted runs and private artifacts

Brewery reserves each step sequence in state before emitting its start event. An
interrupted step therefore keeps its ID; resumed steps get new IDs and result
paths. Agent invocation also removes any old result at its destination before
launch, so a missing result cannot inherit an earlier PASS.

Run acquisition, stale PID recovery, and ownership-checked release are serialized
by a short-lived `run.guard` directory. A crash during that synchronous operation
fails closed: after stopping all commands for that run and verifying none remain,
remove only its `.terreno/brewery/<slug>/run.guard` directory, then resume. Do not
remove a guard while another command may be acquiring or releasing the run lock.
Normal interruption during an agent step leaves no guard and resumes automatically.

Private `.terreno/` artifacts are excluded through the common Git directory,
including linked worktrees. Brewery verifies the exclusion before building tasks.
