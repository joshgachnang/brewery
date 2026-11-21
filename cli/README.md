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
                                  finish: forge waits (no tokens) → claude tastes each red snapshot or unanswered bot thread
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
| `limits.parallelTasks` | `3` | Maximum concurrent task builds. `--parallel N` overrides it for one run; `--parallel 1` runs sequentially. Brewery lowers it when the sandbox is short on memory or threads. |
| `limits.taskMemoryMb`, `limits.taskPids` | `3072`, `300` | What one parallel task is assumed to need; the parallel limit is cut to what the container's memory and free process slots carry. |
| `limits.crashRestarts` | `12` | How often `barrel`, `resume` and `finish` restart themselves after a crash (a Bun panic, an OOM kill). |
| `agents` | `claude` → `opus`, `claude-sonnet` → `sonnet`, `claude-opus` → `opus`, `claude-fable` → `fable` | Every built-in claude profile names its model, so no step takes the account's default model. |
| `stages.pick` | `["claude-sonnet"]` | Implementation runs on Sonnet; once the task has failed `limits.fableAfter` attempts it runs on `claude-fable`. |
| `stages.brew` | `["claude-sonnet"]` | Brew runs final checks and opens the PR on Sonnet. |
| `limits.testFirst` | `true` | Run the `test` step (default agent `claude-sonnet`) before each task's Pick. `false` returns to Pick writing its own tests. |
| `limits.pourMaxTasks` | `6` | The most tasks `brewery pour` approves without asking you. |
| `limits.escalateAfter` | `2` | Runs of a task's `test` step before the next one uses `escalate.test`. Pick and Roast do not count runs; see `limits.fableAfter`. |
| `limits.fableAfter` | `3` | Failed Pick and Roast attempts of a task (`ts.failures`, kept across `retry:` answers) before both run on the Fable agent in `escalate`. The human is asked at `fableAfter + 3` failures, then every 3 more. |
| `escalate` | `{"test": ["claude-opus"], "pick": ["claude-fable"], "roast": ["claude-fable"]}` | Stronger agents per stage for steps that keep failing. A repo's map replaces this one wholesale; `{}` turns escalation off. |

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
| Stuck steps escalate | A task's test step that has run `limits.escalateAfter` times (default 2) runs next on `escalate.test` (`claude-opus`). Pick and Roast run on `escalate[stage]` (`claude-fable`) once the task has `limits.fableAfter` (3) failed attempts. |
| No self-approval | brewery owns the IP's `Status:` line and resets one an agent approved. Only `brewery answer` approves, or `brewery pour` when brewery itself counts at most `pourMaxTasks` tasks and no `fundamental` question; it records that in the Status line. |
| Valid task graph before sign-off | Distill rejects drafts with duplicate task IDs, unknown dependencies, self-dependencies, or cycles. Cut/fix rechecks the graph after every edit and passes remaining problems as blocking decomposition findings, even when Cut found nothing. An invalid graph after `limits.cutRounds` throws before sign-off. |
| Valid task graph before approval | Answer validates the edited IP regardless of the agent's `structural` flag. Invalid graphs go through cut/fix as blocking decomposition findings. Unrepaired problems return to sign-off, with the problems listed; only a valid graph can be approved. |
| Progress can't be faked | brewery checks each task box only after a Roast PASS and cherry-pick onto the feature branch. |
| Bounded loops | Pick attempts per task, cut and review rounds, finish pushes and hours, and a "same failure twice" stop. |
| No tokens while waiting | brewery polls the PR's checks itself through `forge`'s backends (GitHub via `gh`, Forgejo via its API) and starts a Taste agent only on a red snapshot. |
| Privacy | ntfy pings carry no content. The full message prints to the terminal and is saved in state. |

For example, `T1` depending on `T2` while `T2` depends on `T1` produces the finding
`Dependency cycle: T1 → T2 → T1`. A fix must remove the cycle before sign-off can proceed.

## Human loop

When a run needs you, brewery prints one message (and an SMS-length version), pings ntfy,
saves the state, and exits with code 3. When you are at the terminal, it asks for the
reply right there instead. Reply from anywhere with `brewery answer <slug> "<reply>"`:

- sign-off: `ok`, `ok, 2b`, `no: <why>`, or answers without approval (applied, then asked again)
- gates: `1a`, `retry: <hint>`, `skip` (task), `ship` (integration or review), `stop`

A waiting process also takes a reply written to `.terreno/brewery/<slug>/reply.json` as
`{"reply": "ok", "at": "<ISO time>"}`. It checks that file every 2 s and deletes it once it
takes the reply. At a terminal, whichever comes first wins, the typed line or the file.
With no terminal, the process watches the file for `replyWaitMin` minutes before it exits 3.
That value comes only from `BREWERY_REPLY_WAIT_MIN` or `replyWaitMin` in the user config,
never from a repo's `.brewery.json`. It defaults to 0, which exits at once. While it waits,
the process rewrites `waiting.heartbeat` in `state.json` every 5 s, so `brewery ui` can
tell a live waiter. If the file is malformed, the process leaves it in place, emits a
`reply.json unreadable` note, and keeps waiting. `--no-wait` skips both the terminal and
the wait.

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
| `usage` | `seq`, `inputTokens`, `outputTokens`, optional `cacheReadTokens`, `costUsd` | Once per step, just before `step.end`, when the agent reported usage. Claude's final `result` record gives tokens and cost; Codex's `turn.completed` records give tokens only, summed over the step. Counts are the agent's own: Claude's `inputTokens` excludes cache reads, Codex's includes them. Command and Cursor agents emit none. The same totals are stored as `usage` on the step's `state.json` history entry |
| `handoff` | `from`, `to` (both step `seq`s) | Once per routed brief, just after the receiving step's `step.start`, when step `from`'s handoff was put into step `to`'s prompt (see [Handoffs between steps](#handoffs-between-steps)) |
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

### Long commands and the end of a step

A Claude step runs with `BASH_MAX_TIMEOUT_MS` set to 45 minutes, so one Bash call can hold a
package test suite instead of being cut off at Claude Code's 10 minutes and rerun. Set the
variable yourself, in the environment or in the agent profile's `env`, to change it.

Per-task steps divide the testing. Pick runs lint, typecheck, the task's tests, and the
tests near the code it changed. Roast runs each touched package's suite once, with the
repository's parallel or sharded test command when it has one. The integrated roast runs
the full command and the browser suites. Every step keeps a long command's whole output in
a log file and reads failures from it.

A step ends when its agent writes the result file and ends its turn. If the Claude process
is still alive 60 seconds later with no new turn (a background command, a scheduled
wakeup), brewery stops it and uses the result as written; the step log records that. A turn
that ends before the result file exists is left alone, so an agent waiting on its own
subagents is not cut short.

### Leftover test databases and a full disk

A step that is killed or crashes leaves its test databases in the temp directory: an
in-memory MongoDB writes about 300 MB per `mongo-mem-*` directory and removes it only on a
clean exit. Before each step brewery removes the ones that are at least five minutes old,
belong to the current user, and are not named on any live process's command line, in
`$TMPDIR` and `/tmp`, and logs how many it removed and their size. A database a running
server still uses is never touched, and nothing is removed when the process list cannot be
read.

When an agent exits without a result and the volume holding the run, the working copy, or
the temp directory has under 512 MB free, the failure says the disk is nearly full, because
that is what a runtime aborting mid-step looks like.

The sweep also runs when a run starts or resumes and after each task lands, not only before a step.

### Crashes, orphaned agents and a short sandbox

A long run can die without finishing: Bun panics (exit 134), the kernel kills it for memory
(137), or the container restarts. Three things keep that from costing the run.

- **Supervision.** `barrel`, `resume` and `finish` run as a child of a small supervisor that
  starts the same command again after a crash signal or exit status (SIGABRT, SIGKILL, SIGSEGV,
  134, 137, 139), up to `limits.crashRestarts` (`12`) times, sweeping leftover databases and
  waiting a few seconds between tries. A normal exit, an error brewery reports, and a gate for
  the human (exit 3) end supervision. `--no-supervise` or `BREWERY_SUPERVISE=0` runs once.
- **Orphans.** Every agent brewery starts carries `BREWERY_RUN_DIR`, which its own children
  (test servers included) inherit. When a run starts or resumes, brewery stops any such process
  that is not its own descendant (SIGTERM, then SIGKILL after five seconds) *before* the disk
  sweep, which would otherwise skip a database an orphan still names. On SIGTERM, SIGINT or
  SIGHUP it stops its own agents and their children the same way. Linux only, found through
  `/proc`; pids are never remembered, because gVisor reuses low pids across containers.
- **Resources.** A child that fails with `EAGAIN`, `ENOMEM` or "Resource temporarily
  unavailable" is retried after 1, 3 and 9 seconds, and each failure lowers the parallel limit
  by one for the rest of the run. A task whose build died that way goes back to todo (up to six
  times) instead of ending the run. The limit is also cut at the start of every scheduling pass
  to what the container's memory (`limits.taskMemoryMb`, `3072` per task) and free process slots
  (`limits.taskPids`, `300` per task; read from the cgroup, or from `HIVE_PIDS_LIMIT` in a zerg session, whose sandbox cgroup only says `max`) can carry, never below one.

### A PR with no checks is not a green PR

`finish` used to read a PR that reported no checks as green ("0 checks green"), which is what
GitHub shows when jobs are refused before they start (an Actions spending budget, no runner) or
when the forge does not answer. In a repo that defines CI (`.github/workflows`,
`.forgejo/workflows`, `.circleci` or `.buildkite` with files in it), no checks is now pending: after three empty snapshots (each after the
registration wait) brewery asks, and a reply starting with `accept` records that no checks are
expected for this run. Reading checks failing for any reason other than "no checks reported"
is an error, not an empty list.

### finish, barrel, board, and approve on either forge

The CLI reads PRs through `forge`'s backends in-process (`src/forge/ci.ts`), picked from the
checkout's `origin`, so it needs no `~/bin/forge` on a CI runner. Changed files come from the
PR's diff. On Forgejo, bot threads are answered by a reply (the API cannot resolve one), a
flaky run is re-triggered with an empty commit (`forge run rerun` exits 2 there), and
`brewery approve` refuses to post: the approval agent is a GitHub App, so on Forgejo only
`--dry-run` runs.

## Handoffs between steps

Steps of the writing stages (`test`, `pick`, `roast`, `brew`, `taste`) are asked to put a
`handoff` key in their result file: a short brief for whoever works on that code next.
Read-only steps have no result file, so they are never asked.

```json
{"handoff": {"did": "what this step did", "learned": ["about this code"], "traps": ["for whoever comes next"], "files": ["cli/src/handoff.ts"]}}
```

- **Contract.** `did` is a non-empty string of at most 400 characters. `learned`, `traps`,
  and `files` are string lists of at most 8 items, each at most 200 characters; longer
  values are cut. `did`, `learned`, and `traps` are scrubbed like CI logs; `files` loses
  secrets only, so paths keep their digits and dates. A malformed handoff is dropped and the
  step's verdict stands: a handoff is advice, not a result. It must hold no PHI, customer
  data, or secrets.
- **Delivery.** brewery appends the routed briefs to the receiving step's prompt under
  `## Handoffs from earlier steps`, one `### Step <seq>: <stage> <task> (<agent>), <status>`
  entry each, newest last, at most 6. Each one emits a `handoff` event, which is how
  `brewery ui` links the two step cards and fills the step drawer's handoffs in and out.

The routing table is fixed in `cli/src/handoff.ts`: what a step reads depends only on its
stage and task, never on a model's choice.

| Receiving step | Reads the handoffs of | Gets |
| --- | --- | --- |
| `pick <task>` | the newest `test <task>`, and every earlier `pick <task>` and `roast <task>` (retries) | the whole brief |
| `roast <task>` | the newest `pick <task>` | `files` and `traps` only, under "Claims from the implementer: verify them, do not trust them." |
| `pick INTEGRATE`, `pick REVIEW` | each task's last passing `pick` | the whole brief |
| `roast INTEGRATE` | each task's last passing `pick` | `files` and `traps` only |
| `roast REVIEW` | the newest `pick REVIEW` | `files` and `traps` only |
| `brew` | each task's last passing `pick` | the whole brief |
| `taste` | the newest `brew`, and every earlier `taste` | the whole brief |

Every other step (`distill`, `cut`, `test`, `approve`, `calibrate`, `cellar`, and so on)
receives none.

## Dashboard: `brewery ui`

`brewery ui [--port N] [--host H] [--repo PATH] [--scan GLOB]... [--peer NAME=URL#TOKEN]...` serves a web page of this machine's runs and
prints `http://<host>:<port>/?token=<t>`. It serves until killed. The page lists the runs and
follows one run's event feed live. It moves the token into the tab's session storage and
removes it from the address bar.

- **Binding.** The defaults are port 4848 and host `127.0.0.1`. Binding to any other address
  needs an explicit `--host`; there is no environment or config fallback.
  Requests must name that exact address (or `localhost`) in `Host`, so pass the specific
  address clients use, such as a tailnet IP, rather than `0.0.0.0`.
- **Token.** It is random per start, or `BREWERY_UI_TOKEN` when set (set it to keep the same
  URL across restarts). Every `/api/*` request needs it, as an `X-Brewery-Token` header or
  `?token=`. A request whose `Host` (or `Origin`) is neither the bound host nor `localhost`
  gets 403.
- **Runs.** The list holds every run in the slug index plus every run under `--repo`
  (default: the current repository), newest `state.json` first. Run IDs are `local~<slug>`.
  `GET /api/runs` returns `{runs: [{id, source, slug, repo, phase, waiting, live, pr?,
  updatedAt}], sources}`. `live` means the run's `run.pid` is alive, or its waiting heartbeat
  is under 15 seconds old.
- **Scanned workspaces.** `--scan GLOB` (repeatable; without it, `ui.scan` in
  `~/.config/brewery/config.json`, a list of globs) adds one source per glob. On the zerg
  host, `--scan '/srv/agent-workspaces/*/merged'` lists every session's runs. Wildcards
  match within one path segment. Each matching directory with
  `.terreno/brewery/<slug>/state.json` contributes runs `scan~<workspace>~<slug>`, where
  `<workspace>` is the last directory name a wildcard matched (the session name). The entries
  carry `source: "scan"` and `workspace`. The glob's `sources` entry is
  `{id: "scan:<glob>", kind: "scan", status}`. The status is `unreadable` (with `detail`)
  when a matched directory cannot be read; the other runs still list. It is `read-only` when a
  run directory cannot be written; those runs are `writable: false`. Otherwise it is `ok`,
  which includes a glob that matches nothing. Container paths in a scanned `state.json`
  (`repo: "/workspace"`, step logs) are rebased onto the workspace, and a path that cannot be
  rebased, or that `..` would carry out of the workspace, is dropped, never opened. A run
  directory that resolves outside its workspace through a symlink, or whose `state.json` or
  `events.jsonl` is a symlink, is not served. A relative `--scan` is resolved against the
  current directory, and a relative `ui.scan` entry against the home directory. A scanned run counts as PHI only when the workspace's own
  `.brewery.json` has `"phi": true`. Its `run.pid` belongs to the container, so only its
  waiting heartbeat makes it `live`.
- **Peers.** `--peer NAME=URL#TOKEN` (repeatable; without it, `ui.peers` in
  `~/.config/brewery/config.json`, a list of the same strings) merges another `brewery ui`
  instance, such as the zerg host's, into this one. Its runs list as `NAME~<its run id>`
  (`zerg~local~x`, `zerg~scan~<workspace>~<slug>`) with `source: "NAME"`, and its
  `sources` entry is `{id: "NAME", kind: "peer", status}`. A peer that answers with an error,
  refuses the connection, or does not answer the run list within 3 seconds is `unreachable`,
  with `detail` set to its status code (`401` for a wrong token), `timeout`,
  `connection failed`, or `bad response` (not a run list); local runs still list. Every per-run route under `NAME~…` (view, step,
  events, answer, note) is proxied to the peer, which returns its own status and body
  unchanged; the event stream passes `Last-Event-ID` through. This server adds the peer's
  token itself and drops the query string, so the browser never sees a peer token and the
  peer never sees this one. A proxied request whose peer cannot be reached answers 502.
  `NAME` is letters, digits, `.`, `_`, or `-`, and cannot be `local` or `scan`.
- **Event stream.** `GET /api/runs/<id>/events` is a server-sent-event stream of the run's
  `events.jsonl`. Each complete line becomes one message whose `id` is the byte offset after
  that line, so a reconnect with `Last-Event-ID` resumes with the next line. A partial line
  waits for its newline. The server polls the file with `stat`, so it works before the file
  exists and under gVisor.
- **Run view.** `GET /api/runs/<id>` returns the run's view model: pipeline strip, tasks
  with their test/pick/roast step cards, active steps, routes (the repo's configured
  agents unless the run has used others), waiting, PR, totals, and handoffs. A run whose
  `state.json` is corrupt answers 500 `{error}`; an unknown id answers 404.
- **State push.** The event stream also sends `event: state` messages, with the fresh view
  as `data` and no `id`, whenever `state.json`'s mtime changes (checked every second). A
  corrupt write is skipped and the stream stays open. Nothing is pushed on connect, so a
  client that must not miss a change opens the stream before it fetches the view.
- **Scrubbing.** Every event is scrubbed with the same rules as CI logs (tokens, emails,
  phone numbers, and so on) before it leaves the server. In a repo whose `.brewery.json` has
  `"phi": true`, every string except the top-level structural fields (`kind`, `t`, `stage`, `task`,
  `agent`, `status`, `waitingKind`, `state`) becomes `"(withheld: phi)"`. Numbers such as
  `seq`, `seconds`, and PR numbers pass. PHI is opt in: a repo without the flag streams its
  narration unwithheld.

- **Answer and note.** `POST /api/runs/<id>/answer {reply}` does what `brewery answer` does
  without racing a live process. A run whose waiting heartbeat is under 15 seconds old gets
  the reply through its `reply.json` (202 `{via: "reply-file"}`). A local run with
  no live waiter and no live `run.lock` holder gets a detached `brewery answer <slug> <reply>`,
  logging to `.terreno/brewery/<slug>/ui-answer-<ts>.log` (202 `{via: "spawn", pid, log}`);
  that child owns the run until it next waits or finishes. A scanned run is never answered by a
  process on this host. A run that is not waiting, one another process owns, a scanned run with
  no live waiter, or one this server cannot write answers 409 `{error, command}`, where
  `command` is the line to run in that session. `POST /api/runs/<id>/note {text}` appends
  a note as `brewery note` does (200). Both need a JSON body (else 415) and a non-empty
  field (else 400).

- **Step detail.** `GET /api/runs/<id>/steps/<seq>` returns one step for the page's drawer:
  `{seq, stage, task?, agent, prompt?, result?, handoffIn, handoffOut?, logTail?, phiWithheld}`.
  `handoffIn` lists the handoffs from earlier steps that the run's `handoff` events addressed to
  this seq. `logTail` holds the last 80 narration lines parsed from the step's log, never raw
  JSON. Every string is scrubbed. A running step has no `result`. In a PHI run, the route
  returns structure only: no prompt, log tail, or handoffs, and `result` is reduced to
  `{status, counts: {fail, block, ask, findings}}`. A seq that is not a number gets 400, and
  one the run never started gets 404.

## Running `brewery ui` on the zerg host

One page can follow every zerg session's runs and this laptop's. On the zerg host, as the
user that can read `/srv/agent-workspaces`, run:

```sh
BREWERY_UI_TOKEN=<zerg token> brewery ui --host <tailnet ip> --scan '/srv/agent-workspaces/*/merged'
```

`--host` binds the tailnet address only, and a fixed `BREWERY_UI_TOKEN` keeps the URL, and
the laptop's peer line, valid across restarts. It prints `http://<tailnet ip>:4848/?token=…`,
which a phone on the tailnet can open directly. On the laptop, merge it in:

```sh
brewery ui --peer zerg=<zerg url>#<zerg token>
```

where `<zerg url>` is `http://<tailnet ip>:4848`. The zerg runs list as
`zerg~scan~<session>~<slug>`, beside this machine's `local~<slug>` runs. To skip the flags,
put the glob in the zerg host's `ui.scan` and the peer string in the laptop's `ui.peers`.

- **Answering drones.** A drone has no terminal, so it waits only as long as
  `BREWERY_REPLY_WAIT_MIN` (or `replyWaitMin` in its user config) allows. Set
  `BREWERY_REPLY_WAIT_MIN=240` in the zerg image's environment, beside
  `BREWERY_SKILLS_DIR`, and a waiting drone keeps its heartbeat fresh for four hours. An
  answer from the page goes into its `reply.json`, which the drone takes and deletes. After
  the drone has exited, the page answers 409 with the `brewery answer` command to run in that
  workspace's session. The host never starts `brewery answer` for a container's run, because
  that would continue the run's steps outside the container.
- **Permissions.** Run directories are written by the containers. A workspace the host
  user cannot read shows as `unreadable` in `sources`, and one it cannot write is
  `read-only`, so a run there that no live drone is waiting on gets the command instead.
- **PHI.** This page carries every session's runs, so before putting it on the tailnet,
  check that every PHI repo's `.brewery.json` on master has `"phi": true`. PHI is opt in: a
  repo without the flag streams its agents' narration, messages, and results unwithheld.

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

`owner/name` is a GitHub repo; a Forgejo repo is `host/owner/name`, with the host in
`~/.config/forge/hosts.json`. GitHub selects PRs with an `updated:>=` search. Forgejo has no
search, so brewery lists PRs newest-updated first and filters the date itself (and logs when
the 60-PR cap cut the window short); its inline comments carry path and line but no hunk.

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

`owner/name` is GitHub, `host/owner/name` a Forgejo host. On Forgejo, merged PRs are read in
full and filtered by merge date (no `merged:>=` search), and failed runs by `--created` over
the newest 1000 runs; brewery logs when a pass hit its 100-item cap.

One repo per call. It gathers everything since that repo's last pass (first pass: 7 days):
- brewery journals that reached the default branch
- failed GitHub or Forgejo Actions runs, with the newest scrubbed failed-step log per workflow and branch
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

## forge: GitHub and Forgejo from one CLI

`forge` reads and changes pull requests, CI runs, issues and repos on either forge, so skills
and tools stop calling `gh` directly. `bin/install` links it to `~/bin/forge`
(`cli/src/forge/main.ts`). The forge is picked from the repo's host:

1. `-R/--repo` (`OWNER/REPO`, `HOST/OWNER/REPO`, or any remote or web URL), else
2. a URL given as the command's argument (`forge pr view https://…/pulls/3`), else
3. the `origin` remote of the current checkout.

`github.com` runs `gh` (so `gh auth` applies). A host listed in `~/.config/forge/hosts.json`
uses the Forgejo REST API. Any other host is an error, never a guess. A bare `OWNER/REPO`
takes origin's host, and is an error outside a checkout. SSH remotes with a port
(`ssh://git@forgejo.nang.io:2222/o/r.git`), scp-style (`git@github.com:o/r.git`) and https
all work.

### hosts.json

```json
{
  "forgejo.nang.io": {
    "type": "forgejo",
    "url": "https://forgejo.nang.io",
    "token": "<personal access token>",
    "bots": ["brewery-bot"]
  }
}
```

Keyed by the host as it appears in remotes. `url` is the web root; the API is `<url>/api/v1`.
`token` is optional: without it `FORGEJO_TOKEN` is used. `bots` lists logins to report as
bots (Forgejo has no bot flag; logins ending in `-bot` or `[bot]` always count). Keep the
file mode 600; `forge` warns when a file holding a token is readable by others.
`FORGE_HOSTS` points at a different file.

### Commands

Flags follow `gh` so a call swaps by renaming `gh` to `forge`. Every command takes `-R`.
View, list, checks, threads and label take `--json [field,...]` (no list prints every
field) and `-q/--jq <expr>` (run by `jq -r`, like gh's `--jq`).

| Command | gh it replaces | Notes |
| --- | --- | --- |
| `forge pr view [<n>\|<url>\|<branch>] [--comments]` | `gh pr view` | No selector: the current branch's open PR. `--comments` prints the conversation and every review that said something |
| `forge pr list [--state open\|closed\|merged\|all] [--head] [--base] [--author] [--label] [--limit] [--search]` | `gh pr list` | `--search` is GitHub-only. Checks and reviews are fetched per PR only when `--json` asks for them |
| `forge pr create --title t (--body b \| --body-file f) [--base] [--head] [--draft]` | `gh pr create` | Prints the URL. Head defaults to the current branch, base to the default branch. Forgejo drafts are a `WIP:` title prefix |
| `forge pr diff [<pr>]` | `gh pr diff` | |
| `forge pr checks [<pr>] [--watch] [--interval s] [--fail-fast] [--grace s]` | `gh pr checks` | Exit 0 green, 1 red or no checks, 8 running, like gh. `--grace` keeps watching that long while no checks have registered yet |
| `forge pr merge [<pr>] [--merge\|--squash\|--rebase] [--match-head-commit sha] [--delete-branch]` | `gh pr merge` | `--match-head` is an alias. See "Merging at a head" |
| `forge pr comment [<pr>] (--body \| --body-file)` | `gh pr comment` | Prints the comment URL |
| `forge pr threads [<pr>] [--unresolved]` | `gh api graphql` reviewThreads | Review threads with resolved state |
| `forge pr ready [<pr>] [--undo]` | `gh pr ready` | Forgejo: drops (or with `--undo` adds) the `WIP:` title prefix that marks a draft |
| `forge pr edit [<pr>] [--title] [--body \| --body-file] [--add-reviewer a,b] [--remove-reviewer] [--add-label a,b] [--remove-label]` | `gh pr edit` | Forgejo keeps a draft's `WIP:` prefix when the title changes; reviewers go through `requested_reviewers`, labels by name |
| `forge pr review [<pr>] (--approve \| --request-changes \| --comment) [--body \| --body-file]` | `gh pr review` | Forgejo posts the review on the current head and prints its URL; a change request or comment needs a body |
| `forge run list [--branch] [--commit] [--workflow] [--status] [--event] [--created >=date] [--limit]` | `gh run list` | Forgejo's API has no date filter, so `--created` (`>=`, `>`, `<=`, `<` or a bare date for that day) is applied after paging, over the newest 1000 runs |
| `forge run view <id\|url> [--log \| --log-failed] [--job id]` | `gh run view` | |
| `forge run watch <id\|url> [--interval s] [--exit-status]` | `gh run watch` | Polls; `--exit-status` exits 1 unless the run succeeded |
| `forge run rerun <id\|url> [--failed] [--job id]` | `gh run rerun` | GitHub only; exit 2 on Forgejo (see below) |
| `forge run logs <id\|url> [--failed] [--job id]` | `gh run view --log[-failed]` | Lines read `<job>\t<step>\t<timestamp> <text>` on both forges, which `failureExcerpt` expects; Forgejo's step column is `UNKNOWN STEP` |
| `forge issue list [--state open\|closed\|all] [--label] [--limit] [--search]` | `gh issue list` | Forgejo's `--search` is its keyword search |
| `forge issue view <n\|url>` | `gh issue view` | Includes comments |
| `forge issue close <n\|url> [--comment c] [--reason r]` | `gh issue close` | Forgejo has no close reason; it is ignored there |
| `forge issue comment <n\|url> (--body \| --body-file)` | `gh issue comment` | |
| `forge issue label <n\|url> [--add a,b] [--remove c]` | `gh issue edit --add-label/--remove-label` | Prints the labels after the change |
| `forge issue create --title t (--body \| --body-file) [--label a]... [--assignee login]...` | `gh issue create` | Prints the URL. Forgejo: label names must exist in the repo |
| `forge label create <name> [--color hex] [--description d] [--force]` | `gh label create` | Default color `ededed`. An existing label is an error unless `--force`, which updates it |
| `forge repo view [<repo>]` | `gh repo view` | |
| `forge repo clone <repo> [<dir>] [-- <git flags>]` | `gh repo clone` | Forgejo clones the repo's SSH URL |
| `forge api <path> [-X] [-f k=v] [-F k=v] [-H "Name: value"] [--input f] [--paginate] [-q]` | `gh api` | GitHub: handed to `gh api` unchanged (with `GH_REPO` set). Forgejo: the path is relative to `/api/v1`, `{owner}`/`{repo}` are filled in, `-H` headers are sent (never replacing the token), `--paginate` concatenates pages |

Errors print `forge: …` on stderr and exit 1 (2 for an operation the forge cannot do).

Not in `forge`, because they are about GitHub itself rather than a repo's forge: `gh auth`
(`token`, `status`, `login`, `setup-git`, `refresh`), `gh search prs` across owners, and
`gh repo list`. Search qualifiers in `--search` (`merged:>=`, `updated:>=`, `in:title`) only
work on GitHub. `gh api graphql` is GitHub's own API; `forge api` passes it through on GitHub
only.

### JSON schema

`--json` prints one schema for both forges. Field names are gh's `--json` names where gh has
one; values are normalized so a field means the same thing on either forge.

**Pull request** (`pr view`, `pr list`, `pr create --json`)

| Field | Type | Meaning |
| --- | --- | --- |
| `forge` | `"github" \| "forgejo"` | |
| `repo` | string | `owner/name` |
| `number`, `url`, `title`, `body` | | `url` is `/pull/N` on GitHub, `/pulls/N` on Forgejo |
| `state` | `OPEN \| CLOSED \| MERGED` | |
| `isDraft` | boolean | |
| `author` | `{login, isBot}` | |
| `headRefName`, `headRefOid`, `baseRefName` | string | Head branch, head sha, base branch |
| `labels` | `[{name}]` | |
| `mergeable` | `MERGEABLE \| CONFLICTING \| UNKNOWN` | UNKNOWN once closed. Forgejo reports false while it recomputes after a push, so a false is re-read three times, 2s apart, before it is believed |
| `mergeStateStatus` | string | gh's value on GitHub. Forgejo: `DRAFT`, `DIRTY` (conflicting), `UNSTABLE` (checks red or running), `CLEAN`, or `UNKNOWN` when closed |
| `reviewDecision` | `APPROVED \| CHANGES_REQUESTED \| REVIEW_REQUIRED` | See "Approval" |
| `approvedAtHead` | boolean | `reviewDecision` is APPROVED and an approval that decides it was given on `headRefOid`. Merge "at the reviewed head" on this, not on `reviewDecision` |
| `reviews` | `[{id, author, state, body, submittedAt, commit: {oid}, stale}]` | `state` is `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` or `PENDING`. `stale` is Forgejo's flag for a review older than the head; always false on GitHub |
| `comments` | `[{id, author, body, createdAt, url}]` | Conversation comments, not review comments |
| `checks` | `[Check]` | The head's checks, as below |
| `checksState` | `green \| red \| running \| none` | red if any check failed or was cancelled; else running if any is pending; else green; none when there are no checks. Skipped checks alone are green |
| `createdAt`, `updatedAt`, `mergedAt`, `closedAt` | ISO time or null | |

**Check** (`pr checks`, `checks[]` above): `name`, `state` (the forge's own state,
upper-cased), `bucket` (gh's `pass`, `fail`, `pending`, `skipping`, `cancel`), `link`,
`workflow`, `description`, `startedAt`, `completedAt`, `event`. On GitHub these come from
`gh pr checks` (check runs and commit statuses). On Forgejo they are the head commit's
combined statuses, one per context, which Forgejo Actions writes for every job
(`<workflow> / <job> (<event>)`) from the moment it is queued: `success` and `warning` are
pass, `failure` and `error` fail, `pending` pending. Forgejo's relative `target_url` is
made absolute.

**Thread** (`pr threads`): `id`, `path`, `line`, `isResolved`, `isOutdated`, `comments`
(`[{id, author, body, createdAt, url, resolvedBy?}]`). GitHub's come from the GraphQL
`reviewThreads`. Forgejo has no thread object: a thread is every review comment on the same
file and line, as its UI groups them, and `id` is the first comment's id. Forgejo's API
exposes who resolved a conversation (`resolver` on its comments) but no way to resolve one,
and no outdated flag, so `isOutdated` is always false there.

**Run** (`run list`, `run view`): `forge`, `repo`, `databaseId`, `number`, `url`,
`workflowName`, `displayTitle`, `headBranch`, `headSha`, `event`, `status`
(`queued \| in_progress \| completed`), `conclusion` (`success \| failure \| cancelled \|
skipped \| ""`), `createdAt`, `updatedAt`, `startedAt`, `jobs`
(`[{databaseId, name, status, conclusion, url, startedAt, completedAt}]`, filled by
`run view`). `databaseId` is the id every `forge run` command takes and the number in the
run's URL: GitHub's run id, Forgejo's per-repo run number (the API's own run ids are global
and are resolved from it). On Forgejo `workflowName` is the workflow file name, job times are
empty, and a job's `url` is its position in the run (`…/runs/7/jobs/0`).

**Issue** (`issue list`, `issue view`): `forge`, `repo`, `number`, `url`, `title`, `body`,
`state` (`OPEN \| CLOSED`), `author`, `labels`, `assignees` (`[{login}]`), `comments`
(`issue view` only), `createdAt`, `updatedAt`, `closedAt`.

**Repo** (`repo view`): `forge`, `host`, `name`, `owner` (`{login}`), `nameWithOwner`,
`url`, `sshUrl`, `cloneUrl`, `defaultBranchRef` (`{name}`), `isPrivate`.

### Approval

`reviewDecision` is `APPROVED` when the newest deciding review (an approval or a request for
changes) from each reviewer other than the author includes an approval and none requests
changes. Comments, pending and dismissed reviews decide nothing; stale reviews still count,
and `reviews[].commit.oid` says which head each one saw. So a caller that merges only at the
reviewed head must not stop at `reviewDecision`: check `approvedAtHead` (or compare the deciding
approvals' `commit.oid` with `headRefOid` itself) and pass that sha to
`forge pr merge --match-head-commit`. With no deciding review it is
`REVIEW_REQUIRED`. Forgejo always uses this rule. GitHub uses gh's `reviewDecision` when the
repo's branch protection sets one, and this rule when it is empty.

### Merging at a head

`forge pr merge --match-head-commit <sha>` refuses (exit 1) when the PR's head is not that
sha. On GitHub this is gh's own flag. On Forgejo, forge reads the head and refuses before
calling merge, then sends the sha as `head_commit_id`, which Forgejo checks again
server-side (HTTP 409 "head out of date", reported as the same refusal), so a push between
the read and the merge is caught too. Right after a push Forgejo can answer 405 "Please try again later"
while it rechecks the PR; forge retries that up to five times, backing off, and treats any
other 405 as final.

### Tokens in output

Forgejo's 401 reply echoes the token it was sent. forge replaces every configured token
(each hosts.json token and `FORGEJO_TOKEN`) with `[REDACTED]` in error messages and in
`forge api` output.

### Rerunning on Forgejo

Forgejo 16 has no API to rerun a run: its Re-run button is a web route that needs a browser
session, and a workflow dispatch starts a separate run whose statuses do not replace the
failed one. `forge run rerun` on Forgejo exits 2 with the run's link. Push a commit or rerun
from the web UI.

### Tests

`test/forge.test.ts` runs both backends against responses recorded from the live forges in
`test/fixtures/forge/` (Forgejo 16.0.2 on `joshgachnang/forgejo-scratch`; gh on the public
`TerrenoLabs/terreno`), with a fake Forgejo served by `Bun.serve` and a fake `gh` on PATH.
`FORGE_LIVE=1 bun test test/forge-live.test.ts` opens a real PR on the scratch repo, waits for
its checks, reads threads, refuses a merge at a moved head and merges at the real one. It
needs the tailnet, SSH to `forgejo.nang.io:2222`, and an admin token in hosts.json (the
reviews are posted as `brewery-bot` with `Sudo`).

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
