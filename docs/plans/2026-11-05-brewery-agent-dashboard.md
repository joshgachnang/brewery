# brewery live agent dashboard and curated handoffs

brewery already runs every pipeline stage (distill → cut → sign-off → barrel → finish) as its
own agent process. It routes each stage to the agents named in `.brewery.json` or
`--agents`, and appends progress to `.terreno/brewery/<slug>/events.jsonl`. Following a run
is hard today. You tail logs step by step, and nothing shows parallel tasks, fan-out
agents, or what each step handed the next, least of all across the zerg sessions where most
runs happen. Context moves only as fixed packets (IP, brief, evidence JSON), so a retry
Pick or a Taste re-learns what the step before it already knew. This plan adds
`brewery ui`, a web dashboard of every run and every agent as it works, local and in zerg,
in one view. It also adds a short handoff brief that each step writes for the steps after
it. Josh feels the difference on every run: one page answers "what is running, on which
agent, what did it just do, and what is waiting on me", and answering happens on that page.

## The idea

Three contracts change:

1. **Run view API.** `brewery ui` is a token-guarded HTTP server that serves one page.
   - **Run discovery.** It finds runs from three kinds of source:
     - this machine's slug index and repo;
     - scan roots such as `/srv/agent-workspaces/*/merged` on the zerg host, where every
       session's `/workspace` lives;
     - peers, meaning other `brewery ui` instances it proxies. A laptop instance lists the
       zerg host's runs this way.
   - **Run IDs.** Every run has the ID `<source>~<slug>`.
   - **Routes.** The run list; a run's view model (pipeline, tasks, active agents, waiting,
     totals); a server-sent-event stream that tails `events.jsonl` by byte offset and
     pushes state changes; a step's detail; and answer/note.
   - **Scrubbing.** Every event is scrubbed before it leaves the server. A PHI run (`phi: true` in its repo's
     `.brewery.json`) shows structure only: no free text.
   - **Testing.** All UI logic lives in a server-side view model that `bun test` covers.
     The page only renders it.
2. **Reply pickup.** A waiting brewery process watches `.terreno/brewery/<slug>/reply.json`
   alongside its terminal prompt, and refreshes `waiting.heartbeat`.
   - The UI answers a run with a live waiter by writing that file. This works the same for
     a CLI sitting at its TTY and for a drone inside a zerg container.
   - A local run with no waiter is answered by a detached `brewery answer`.
   - A zerg run with no waiter gets the exact command to run in that session.
3. **Handoff brief.** Every writing step's result file may carry
   `handoff: {did, learned[], traps[], files[]}`, capped and scrubbed.
   - A fixed routing table in `handoff.ts` decides which earlier handoffs each later step
     receives.
   - Cut and the test writer never receive any. Roast receives only Pick's `files` and
     `traps`, labelled as claims to verify.
   - Every handoff that is passed is recorded as an event, and the UI draws it.

Rejected: a new harness on the Claude Agent SDK, because brewery's step engine, routing,
gates, locks, and tests already do the orchestration (D1). Also rejected: a new hive event
kind for zerg runs, because scanning the workspaces on the host needs no change to hive.

## The plan

| # | Task | Depends on | Lands in | Proves it |
| --- | --- | --- | --- | --- |
| T1 | Tracer: `brewery ui` serves the run list and a scrubbed live event stream | none | cli/src/ui/, cli/src/commands/ui.ts, cli/src/cli.ts | E1 |
| T2 | Run view model and the new event kinds | none | cli/src/ui/view.ts, cli/src/events.ts | unit cases |
| T3 | Usage events: tokens and cost per step | T2 | cli/src/agents.ts, cli/src/step.ts | E2 |
| T4 | Handoff field in step results | T3 | cli/src/agents.ts, cli/src/prompts.ts | unit cases |
| T5 | Handoff routing between steps | T4 | cli/src/handoff.ts, barrel, finish | E3 |
| T6 | Run view route and state push | T1, T2 | cli/src/ui/routes/view.ts | E4 |
| T7 | Step detail route | T1, T5 | cli/src/ui/routes/step.ts | E5 |
| T8 | A waiting run picks up replies from a file | T1, T3 | cli/src/human.ts, cli/src/cli.ts | E6 |
| T9 | Answer and note from the UI | T8 | cli/src/ui/routes/answer.ts | E7 |
| T10 | Scan zerg workspaces for runs | T8 | cli/src/ui/runs.ts | E8 |
| T11 | Peers: one view across machines | T10 | cli/src/ui/peers.ts, server | E9 |
| T12 | The dashboard page | T6, T7, T9, T11 | cli/src/ui/page.html | E10, BREW-new-1 |
| T13 | Docs, overview skill, regression case | T5, T12 | READMEs, overview skill, manifests | layout test |

Tracer: `brewery ui` → GET /api/runs + SSE tail of one run's scrubbed `events.jsonl` → a page showing the raw feed.
E2E: 10 specs (process layer, `cli/test/`).
Regression: BREW-new-1 (walk the dashboard across a local and a zerg run) → docs/regression/brewery.md.
User guide: None — user guide off.
Design: None — no Claude Design canvas; the layout is specified in T12.
v1 limit: a zerg run whose drone already exited is answered by copying a command into that session (D5). Every other wait is answered on the page.
Out of scope: starting runs from the UI, editing routing from the UI, a browser test layer, model-chosen handoffs, Shade console view (see Expansions).
Open risks: the zerg host runs `brewery ui` as `josh`, and container-written run directories must be readable by that user (T10 reports unreadable roots instead of failing); answering a zerg run whose drone already exited needs a command run in the session (D5).
Elephant: The zerg-host instance puts every session's runs, Flourish repos included, on one tailnet page. PHI is opt-in (D7), so a Flourish repo missing `"phi": true` in its `.brewery.json` streams its agents' narration, messages, and results unwithheld.

## E2E tests

| ID | Spec or flow | Layer | Proves | Written in |
| --- | --- | --- | --- | --- |
| E1 | cli/test/ui-server.test.ts | process | `brewery ui` on port 0 lists local runs and streams `events.jsonl` lines as SSE in order. It resumes from `Last-Event-ID`, scrubs secrets from every line, withholds every free-text field in PHI runs, and rejects requests that lack the token or carry a foreign `Host` | T1 |
| E2 | cli/test/usage.test.ts | process | A step run against the fake agent's Claude and Codex usage records emits one `usage` event and stores tokens and cost in history | T3 |
| E3 | cli/test/handoff.test.ts | process | In a fake-agent barrel run, Pick's handoff reaches the retry Pick, and Roast gets only its files and traps. The cut and test prompts contain no handoff, and a `handoff` event names both ends | T5 |
| E4 | cli/test/ui-view.test.ts | process | GET /api/runs/:id returns the view model, and the SSE stream emits a `state` message after state.json changes | T6 |
| E5 | cli/test/ui-step.test.ts | process | GET /api/runs/:id/steps/:seq returns prompt, result, handoffs in and out, and a scrubbed log tail. A PHI run gets structure only: no prompt, log tail, or handoffs, and the result reduced to its status and counts | T7 |
| E6 | cli/test/reply-pickup.test.ts | process | A waiting brewery process applies a reply written to `reply.json` and continues, keeps `waiting.heartbeat` fresh while waiting, and still accepts a terminal reply | T8 |
| E7 | cli/test/ui-answer.test.ts | process | POST answer writes `reply.json` when a waiter is live. It spawns a detached `brewery answer` for a local run with no waiter, and returns 409 with the command for a scanned run with no waiter. Token, `Origin`, and content-type are enforced | T9 |
| E8 | cli/test/ui-scan.test.ts | process | `--scan '<tmp>/*/merged'` lists runs from every matching workspace as `<source>~<slug>`, keeps same-slug runs in two workspaces apart, and reports an unreadable root without failing | T10 |
| E9 | cli/test/ui-peers.test.ts | process | A UI with `--peer zerg=<url>#<token>` lists the peer's runs as `zerg~…` and proxies view, step, SSE, and answer to it. A down peer shows as `unreachable` while local runs still list | T11 |
| E10 | cli/test/ui-page.test.ts | process | GET / returns the embedded page, which calls only the routes the server registers. The page is imported as text, so `bun build --compile` embeds it | T12 |

## Regression cases

Destination: BREW → docs/regression/brewery.md

| ID | Case | Steps | Expected | Platforms | Automated by | Added |
| --- | --- | --- | --- | --- | --- | --- |
| BREW-new-1 | The dashboard follows a local run and a zerg run in one view | 1. On the zerg host, run `brewery ui --host <tailnet ip> --scan '/srv/agent-workspaces/*/merged'`. 2. In one zerg session, run `brewery pour "<small 3-task feature>"` in a scratch repo. 3. On the laptop, run `brewery ui --peer zerg=<url>#<token>` and start `brewery barrel <slug> --parallel 2` on a local approved 3-task scratch IP at the terminal. 4. Open the laptop page in Chrome and the zerg page on a phone. 5. When either run stops at a gate or sign-off, answer it from the page | The run list shows both runs with their source. The pour run's strip moves distill → cut → sign-off → barrel → finish. The local run shows distill, cut, and sign-off as skipped and starts at barrel. All three tasks show test/pick/roast cards, two running at once, with live narration. The fan-out roast shows one card per agent side by side. Pick T1's card links to the roast T1 card it handed off to. After the page loads, the address bar has no `token=`. Restarting the laptop `brewery ui` with the same `BREWERY_UI_TOKEN` resumes the feed with no duplicate lines. The zerg host can write `reply.json` into the drone's run directory, and the drone deletes it after taking the reply. The answer clears the wait in both runs, including the one sitting at a terminal prompt. Both pages are readable at phone width | Chrome desktop, iOS Safari | E1, E4, E6, E7, E9, E10 (data paths); layout, motion, and the real zerg filesystem are manual | brewery-agent-dashboard |

## User guide

None — user guide off.

## Design

None — no Claude Design canvas. The layout is specified in T12's Criteria.

## Tasks

- [x] **T1** — Serve the run list and a scrubbed live event stream with `brewery ui`
  - Depends on: none
  - Files: cli/src/commands/ui.ts, cli/src/ui/server.ts, cli/src/ui/runs.ts, cli/src/ui/tail.ts, cli/src/ui/redact.ts, cli/src/ui/routes/view.ts, cli/src/ui/routes/step.ts, cli/src/ui/routes/answer.ts, cli/src/ui/page.html, cli/src/text.d.ts, cli/src/cli.ts, cli/README.md, README.md, cli/test/ui-server.test.ts
  - Criteria: `brewery ui [--port N] [--host H] [--repo PATH]` prints `http://<host>:<port>/?token=<t>` and serves until it is killed.
    - Token: random per start, or taken from `BREWERY_UI_TOKEN`.
    - Every `/api/*` request needs the token (`X-Brewery-Token` header or `?token=`), and a `Host` header that matches the bound host or `localhost`.
    - Binding to a non-loopback host needs `--host` explicitly.
    - Run IDs are `local~<slug>`, and `runs.ts` exports `findRun(id) → {state, source, runDir, repoRoot, phi, writable}` so later routes resolve runs one way. Every route reads files, `.brewery.json`, and the PHI flag only through these fields, never through `state.repo`. For a local run, `repoRoot` is `state.repo`, `phi` comes from its `.brewery.json` (default false), and `writable` is true. T10 only adds a source; it changes no route.
    - `redact.ts` scrubs each outgoing event with `scrub.ts`'s rules. In a PHI run (a repo whose `.brewery.json` has `phi: true`), it withholds every free-text field and keeps only structure (stage, task, agent, status, seq, timing, usage, PR number, CI state). Narration `text`, `step.end.action`, `waiting.message`, `note.text`, and `error.message` become `"(withheld: phi)"`.
    - The view, step, and answer route modules exist and return 501, so each later task writes only its own module.
    - The page is a thin placeholder (run list and raw feed), imported as text.
    - HELP, `cli/README.md`, and the root README's CLI table list `ui`, as layout.test requires.
  - Seam: the `ui` command's server (HTTP on a real port)
  - Interface:
    - `startUi({repo, port, host, token, scan?: string[], peers?: Peer[]}) → {url, port, stop()}`
    - `GET /api/runs` → `{runs: [{id, source, slug, repo, phase, waiting: boolean, live: boolean, pr?: number, updatedAt}], sources: [{id, kind, status: "ok" | "unreadable" | "unreachable", detail?}]}`
    - `live` means `run.pid` is held by a live pid, or `waiting.heartbeat` is less than 15 s old.
    - `GET /api/runs/:id/events` → `text/event-stream`. One `id: <byteOffsetAfterLine>` and `data: <scrubbed json>` per complete line.
  - Cases:
    - The index maps slug `a` to repo R1 (phase build), and the cwd repo has run `b` (phase signoff, waiting) → the list holds `local~a` and `local~b`, `b.waiting` is true, and they are sorted by updatedAt desc
    - An index entry whose repo no longer exists → skipped, no 500
    - events.jsonl with 3 lines → SSE delivers 3 messages in order with increasing ids. Appending a 4th complete line delivers it. A partial line delivers nothing until its newline arrives
    - Reconnect with `Last-Event-ID` = the id of line 2 → only lines 3 and 4 come back
    - Run with no events.jsonl yet → the stream opens and delivers the first line once the file appears
    - A narration line `Bash: curl -H "Authorization: Bearer abc.def"` → it arrives as `Bash: curl -H "Authorization: Bearer [token]"`
    - The same run in a repo with `.brewery.json` `{"phi": true}` → narration `text`, `step.end.action`, and `waiting.message` are `(withheld: phi)`. `step.start`, `step.end.status`, and `seconds` arrive unchanged
    - No token → 401. Wrong token → 401. `Host: evil.example` → 403
    - Unknown id → 404
    - `/api/runs/local~a` and `/api/runs/local~a/steps/1` → 501 until T6 and T7
  - Blast radius: none (a new read-only server). `cli.ts` gains one command.
  - Test skills: none (bun test, process layer per docs/testing/e2e.md)

- [x] **T2** — Build a run view model, and add the `usage` and `handoff` event kinds
  - Depends on: none
  - Files: cli/src/ui/view.ts, cli/src/events.ts, cli/test/ui-view-model.test.ts
  - Criteria:
    - One pure function turns a run's state, its parsed events, and its routes into everything the page draws, so the page holds no derivation logic.
    - `BreweryEvent` gains `{kind: "usage", seq, inputTokens, outputTokens, cacheReadTokens?, costUsd?}` and `{kind: "handoff", from: number, to: number}`. These are types only; T3 and T5 emit them.
  - Seam: `buildRunView` (exported function)
  - Interface: `buildRunView({state, events, configuredRoutes: Record<Stage, string[]>, phi: boolean, now}) → RunView`
    - `pipeline: {stage: "distill"|"cut"|"signoff"|"barrel"|"finish", status: "done"|"active"|"waiting"|"todo"|"skipped"}[]`
    - `tasks: {id, title, status, attempts, lanes: {test: StepCard[], pick: StepCard[], roast: StepCard[]}}[]`
    - `active: StepCard[]`: steps with a `step.start` and no `step.end`
    - `steps: StepCard[]`
    - `routes: Record<Stage, {agents: string[], from: "run" | "config"}>`: agents seen in this run's `step.start` events win over the configuration
    - `waiting?: {kind, message, asks, live: boolean}`
    - `pr?: {number, url, ci?}`
    - `totals: {seconds, costUsd?, inputTokens?, outputTokens?}`
    - `handoffs: {from, to}[]`
    - `StepCard = {seq, stage, task?, agent, status: "running"|"PASS"|"FAIL"|"BLOCKED"|"PENDING", startedAt, seconds?, action?, narration: string[] (last 20), usage?}`
  - Phase mapping (pipeline statuses for distill / cut / signoff / barrel / finish):
    - `distill` → active / todo / todo / todo / todo. Once a cut step has started → done / active / todo / todo / todo
    - `signoff` → done / done / waiting / todo / todo
    - `approved`, `build`, `integrate`, `review` → done / done / done / active / todo (`waiting` replaces `active` while `state.waiting` is set)
    - `brew`, `finish` → done / done / done / done / active
    - `done` → all done
    - A run with no distill or cut steps in history (started by `barrel` on an existing IP) → distill, cut, and signoff are `skipped`
  - Cases:
    - Phase `build`, T1 passed, T2 running → pipeline distill, cut, and signoff `done`, barrel `active`, finish `todo`. T2's card is in `active`
    - Two `step.start` events with stage `roast`, agents `claude` and `codex`, and no ends → two active cards
    - 30 narration events for seq 4 → card 4 holds the last 20, in order
    - A `step.end` FAIL for pick T2, then a new pick T2 start → the T2 pick lane has two cards, the first FAIL
    - `waiting` set (gate) → pipeline barrel is `waiting`, and `waiting.message` and `asks` are copied
    - Usage events for seq 1 (100 in / 10 out / $0.01) and seq 2 (200 / 20 / $0.02) → totals 300 / 30 / $0.03. With no usage events, the cost and token fields are absent, not 0
    - Event `{kind: "handoff", from: 3, to: 5}` → `handoffs` is `[{from: 3, to: 5}]`
    - configuredRoutes `pick: ["codex"]`, plus a `step.start` for pick with agent `claude` → `routes.pick` is `{agents: ["claude"], from: "run"}`. Unseen stages report `from: "config"`
    - `phi: true` with narration events → every card's `narration` is `[]` and `action` is absent, `waiting.message` is `(withheld: phi)`, and the asks are reduced to their count
    - Phase `done` → every pipeline stage `done`, `active` empty
    - Phase `review` with no distill or cut history → skipped / skipped / skipped / active / todo
    - Phase `signoff` → done / done / waiting / todo / todo
    - Empty events → a valid view built from state alone
  - Blast radius: `events.ts` is imported by every emitter. Adding union members changes no emitted output → the existing narration and flow tests pass unchanged.
  - Test skills: none

- [x] **T3** — Record tokens and cost for every step
  - Depends on: T2
  - Files: cli/src/agents.ts, cli/src/step.ts, cli/src/state.ts, cli/test/fixtures/fake-agent.ts, cli/test/usage.test.ts
  - Criteria:
    - brewery reads usage from the agent's own stream: Claude's final `result` record (`usage`, `total_cost_usd`) and Codex's `turn.completed` `usage`.
    - It emits one `usage` event per step and stores the usage on the history entry.
    - Agents that report nothing record nothing.
  - Seam: `parseUsageLine` (exported), and `runStage` driven by the fake agent
  - Interface: `parseUsageLine(type, line) → {inputTokens, outputTokens, cacheReadTokens?, costUsd?} | null`. `HistoryEntry.usage?` has the same shape.
  - Cases:
    - Claude `{"type":"result","usage":{"input_tokens":1200,"output_tokens":300,"cache_read_input_tokens":5000},"total_cost_usd":0.042}` → `{inputTokens:1200, outputTokens:300, cacheReadTokens:5000, costUsd:0.042}`
    - Codex `{"type":"turn.completed","usage":{"input_tokens":900,"cached_input_tokens":100,"output_tokens":50}}` → `{inputTokens:900, outputTokens:50, cacheReadTokens:100}`, no costUsd
    - Two Codex turns in one step, 900/50 and 100/10 → one event, 1000/60
    - A `command` agent, or a step with no usage lines → no `usage` event, and `history[i].usage` is undefined
    - A malformed line → null, no throw
    - The fake agent prints a Claude result line → `events.jsonl` has the `usage` event between that seq's `step.start` and `step.end`
  - Blast radius: `state.history` is read by journal.ts, provenance.ts, and pipeline.ts, and the new field is optional → the existing journal and provenance cases in unit.test.ts pass unchanged.
  - Test skills: none

- [ ] **T4** — Let every writing step return a handoff brief
  - Depends on: T3
  - Files: cli/src/agents.ts, cli/src/prompts.ts, cli/test/handoff-contract.test.ts
  - Criteria:
    - `StepResult.handoff` is optional.
    - `readResult` validates it, caps it, and scrubs it. A malformed handoff is dropped; the step does not fail.
    - `did`, `learned`, and `traps` get the full `scrub.ts` rules. `files` gets only the secret and token rules, so paths survive.
    - The step header tells non-read-only steps to write a handoff: what they did, what they learned about this code, traps for whoever comes next, and the files that matter. It must contain no PHI and no secrets.
  - Seam: `readResult` and `header` (exported functions)
  - Interface: `handoff?: {did: string; learned: string[]; traps: string[]; files: string[]}`. Caps: `did` ≤ 400 chars, each list ≤ 8 items of ≤ 200 chars, with extras truncated and marked `…`.
  - Cases:
    - A valid handoff → returned unchanged
    - `learned` with 12 items → 8 kept. A 1,000-char `did` → 400 chars ending `…`
    - `handoff: "text"`, or a handoff missing `did` → the result is returned without `handoff`, with the status as the agent wrote it
    - No handoff → the result is unchanged
    - `traps: ["token sk-abcdefghijklmnopqrstuv in .env"]` → `["token [token] in .env"]`
    - `files: ["docs/plans/2026-11-05-x.md", "cli/src/ids/12345678.ts"]` → unchanged
    - `header(..., {readOnly: false, handoff: true})` contains the `handoff` shape. With `handoff: false` or `readOnly: true` it does not mention it
  - Blast radius: `readResult` feeds every stage → the flow.test.ts suite passes unchanged
  - Test skills: none

- [ ] **T5** — Pass handoffs to the steps that need them
  - Depends on: T4
  - Files: cli/src/handoff.ts, cli/src/prompts.ts, cli/src/step.ts, cli/src/commands/barrel.ts, cli/src/commands/finish.ts, cli/test/handoff.test.ts
  - Criteria:
    - A fixed table decides which earlier handoffs each step receives.
    - Each handoff appears in the prompt under `## Handoffs from earlier steps`, with its source step, agent, and verdict.
    - Each delivery emits `{kind: "handoff", from, to}`.
    - Roast's copy is limited and labelled.
    - The routing keys match the stage and task labels barrel and finish actually pass to `runStage` (`test`/`pick`/`roast` with a task id, `INTEGRATE`, `REVIEW`, `brew`, `taste`). Verify them against those call sites before writing the table.
  - Seam: `handoffsFor` (exported), and a barrel run against the fake agent
  - Interface: `handoffsFor(state, {stage, task?}) → {seq, stage, agent, status, handoff}[]`, read from the run's `steps/*.result.json`. Routing:
    - pick T ← the latest test T, plus every earlier pick T and roast T (retries)
    - roast T ← the latest pick T, `files` and `traps` only
    - pick INTEGRATE ← each task's last passing pick
    - roast INTEGRATE ← each task's last passing pick, `files` and `traps` only
    - pick REVIEW ← each task's last passing pick
    - roast REVIEW ← the latest pick REVIEW, `files` and `traps` only
    - brew ← each task's last passing pick
    - taste ← brew and every earlier taste
    - distill, cut, test, review, compound, cellar, approve, calibrate ← nothing
    - Only source stages (test, pick, roast, brew, taste) are asked to write a handoff. T4's header instruction is conditional on the stage, and T5 passes the stage in
  - Cases:
    - pick T2 wrote handoff H, and roast T2 FAILed with handoff R → the retry pick T2 prompt contains H and then R, newest last
    - The roast T2 prompt contains H's files and traps under the line "Claims from the implementer: verify them, do not trust them", and contains neither H's `did` nor its `learned`
    - A test T2 retest after a roast FAIL → the prompt has no `## Handoffs` section
    - A cut prompt in a distill run, after earlier steps wrote handoffs → no `## Handoffs` section
    - Taste #3 → its prompt contains brew's handoff and those of tastes #1 and #2
    - A source step with no handoff → skipped, no empty heading
    - More than 6 qualifying handoffs → the newest 6
    - Each delivered handoff emits a `handoff` event with the source and receiving seq
    - roast INTEGRATE → its prompt holds each task's pick files and traps, and no `did`
    - The cut, review, and distill prompts carry no handoff instruction in their header
  - Blast radius: prompt bodies change for pick, roast, integrate, review fix, brew, and taste → the flow.test.ts and review.test.ts cases that match prompt text still pass. A test-first run still rejects a Pick that changes tests without a reason.
  - Test skills: none

- [x] **T6** — Serve a run's view and push state changes
  - Depends on: T1, T2
  - Files: cli/src/ui/routes/view.ts, cli/test/ui-view.test.ts
  - Criteria:
    - `GET /api/runs/:id` returns `buildRunView` for the run, with `configuredRoutes` from `loadConfig(findRun(id).repoRoot)` and `phi` from `findRun(id).phi`.
    - The events stream also sends `event: state` with the fresh view whenever `state.json`'s mtime changes, checked every second.
  - Seam: HTTP route on the T1 server
  - Interface: `GET /api/runs/:id` → `RunView` JSON. SSE `event: state`, `data: RunView`.
  - Cases:
    - A run in build with one running step → 200, `active.length` 1
    - Writing a new phase to state.json while a stream is open → a `state` message with that phase arrives before the test's 3 s deadline
    - A corrupt state.json → 500 `{error}`, and the stream stays open. The next valid write recovers it
    - Unknown id → 404. No token → 401
  - Blast radius: none (read-only)
  - Test skills: none

- [ ] **T7** — Show a step's prompt, result, handoffs, and log tail
  - Depends on: T1, T5
  - Files: cli/src/ui/routes/step.ts, cli/test/ui-step.test.ts
  - Criteria:
    - One route returns everything about a step for the detail drawer, scrubbed.
    - `handoffIn` comes from the run's `handoff` events whose `to` is this seq.
    - In a PHI run, everything but structure is withheld: no prompt, no log tail, no handoffs. `result` keeps only `status` and the counts of `fail`, `block`, `ask`, and `findings`.
  - Seam: HTTP route on the T1 server
  - Interface: `GET /api/runs/:id/steps/:seq` → `{seq, stage, task?, agent, prompt?: string, result?: StepResult, handoffIn: {seq, handoff}[], handoffOut?: Handoff, logTail?: string[], phiWithheld: boolean}`. `logTail` is the last 80 narration-parsed lines.
  - Cases:
    - Step 3 with a prompt, result, and log → every field present, and the log tail is narration lines, not raw JSON
    - A log containing `ghp_` plus 36 characters → `[token]` in logTail
    - A `phi: true` repo → `phiWithheld: true`, with no `prompt`, `logTail`, `handoffIn`, or `handoffOut`. `result` is `{status: "FAIL", counts: {fail: 2, block: 0, ask: 1, findings: 0}}`
    - A running step with no result file → 200, no `result`
    - `handoff` event `{from: 3, to: 5}` and step 3 has a handoff → step 5's `handoffIn` is `[{seq: 3, handoff}]`
    - A seq not in the run → 404. A non-numeric seq → 400
  - Blast radius: none (read-only)
  - Test skills: none

- [ ] **T8** — Let a waiting run pick up a reply written to a file
  - Depends on: T1, T3
  - Files: cli/src/human.ts, cli/src/cli.ts, cli/src/state.ts, cli/src/config.ts, cli/test/reply-pickup.test.ts
  - Criteria:
    - While a brewery process waits for the human, it watches `.terreno/brewery/<slug>/reply.json` every 2 s.
    - With a TTY, it also takes a terminal line, read asynchronously so the file is still watched. Whichever arrives first wins.
    - It rewrites `state.waiting.heartbeat` every 5 s.
    - It deletes `reply.json` after taking it, then applies the reply through the existing `answer` path.
    - Without a TTY, it keeps waiting for `replyWaitMin` minutes before exiting 3. The value comes from the environment, never from a repo's `.brewery.json`: `BREWERY_REPLY_WAIT_MIN`, or `replyWaitMin` in the user config (`~/.config/brewery/config.json`). The default 0 exits at once, as today. The zerg image sets the env var, so laptop and cron runs of the same repo still exit 3.
  - Seam: `waitForReply` (exported), and a CLI run against the fake agent
  - Interface: `waitForReply({state, tty?: ReadableStream | null, replyWaitMin, pollMs}) → Promise<string | null>`. The file shape is `{reply: string, at: ISO}`.
  - Cases:
    - With `replyWaitMin: 1`, no TTY, and `{"reply":"ok"}` written after 100 ms → resolves `"ok"`, and reply.json is gone
    - With a TTY stream that emits `"1a\n"` before any file → resolves `"1a"`
    - While waiting → `state.waiting.heartbeat` is updated at least twice within 12 s (with a short test interval via `pollMs`)
    - With `replyWaitMin: 0` and no TTY → resolves null at once, and the run exits 3 as before
    - `BREWERY_REPLY_WAIT_MIN=1` with no user config, and a repo `.brewery.json` with `replyWaitMin: 240` → waits 1 minute (the repo value is ignored)
    - A malformed reply.json → ignored and left in place, a `note` event `reply.json unreadable` is emitted, and waiting continues
    - A fake-agent pour run that waits at sign-off with `replyWaitMin: 1`, given `{"reply":"ok"}` → it approves and continues into barrel in the same process
  - Blast radius: `cli.ts` `replyLoop` is used by distill, pour, barrel, and finish → the existing flow.test.ts gate and sign-off cases (no TTY, wait 0) pass unchanged
  - Test skills: none

- [ ] **T9** — Answer a waiting run and add notes from the UI
  - Depends on: T8
  - Files: cli/src/ui/routes/answer.ts, cli/test/ui-answer.test.ts
  - Criteria:
    - The page can do what `brewery answer` and `brewery note` do, without racing a live process.
    - If the run has a live waiter (heartbeat < 15 s), the route writes `reply.json`.
    - Else, for a `local~` run with no lock holder, it starts `brewery answer <slug> <reply>` detached. Output goes to `.terreno/brewery/<slug>/ui-answer-<ts>.log`. That child owns the run until it next waits or finishes; its pid is in `run.pid`, so the run list shows it `live`, and its steps stream like any other.
    - Else, including any run whose `findRun(id).writable` is false, it returns 409 with the command to run in that session.
    - Requests must be JSON POSTs with the token. A foreign `Origin` is rejected.
  - Seam: HTTP route on the T1 server, with a real child process against the fake agent
  - Interface:
    - `POST /api/runs/:id/answer {reply}`
      - 202 `{via: "reply-file"}` when a live waiter took the file
      - 202 `{via: "spawn", pid, log}` when a detached `brewery answer` was started
      - 409 `{error, command}` when there is no waiter and it cannot spawn (a scanned zerg run), or when a non-waiting process holds `run.lock`
      - 409 when the run is not waiting
    - `POST /api/runs/:id/note {text}` → 200. It appends to the run's notes the same way `brewery note` does.
    - 400 for an empty reply. 415 for a non-JSON body. 401 without the token. 403 for a foreign `Origin`.
  - Cases:
    - Waiter heartbeat 2 s old, reply `ok` → 202 `reply-file`, and reply.json contains `{"reply":"ok"}`
    - A local run waiting at sign-off with no waiter, reply `ok` → 202 `spawn`. After the child exits, the phase is `approved` and the ui-answer log exists
    - A local run at a gate with no waiter, reply `retry: use the fixture` → 202 `spawn`, and the child continues the build. Its `step.start` events appear in events.jsonl, and it ends by waiting again or `done`
    - `scan~ws1~x` waiting with no waiter → 409, and `command` is `brewery answer x "<reply>"`
    - A live process holds run.lock and the run is not waiting → 409, and nothing is spawned
    - `findRun` returns `writable: false` (stubbed source) for a waiting run with a live waiter → 409 with `command`, and no reply.json written
    - A run that is not waiting → answer 409, note 200, and the text appended to `state.notes`
    - `Content-Type: application/x-www-form-urlencoded` → 415. `Origin: https://evil.example` → 403
  - Blast radius: `state.answers` and `state.notes` feed every later prompt. They are written only through the existing answer and note paths (a spawned command, or the waiter's own loop), never by the server directly.
  - Test skills: none

- [ ] **T10** — Find runs in zerg session workspaces
  - Depends on: T8
  - Files: cli/src/ui/runs.ts, cli/src/ui/redact.ts, cli/src/commands/ui.ts, cli/src/config.ts, cli/test/ui-scan.test.ts
  - Criteria:
    - `--scan <glob>` (repeatable, or `ui.scan` in `~/.config/brewery/config.json`) adds a scan source.
    - Each directory that matches the glob and contains `.terreno/brewery/*/state.json` contributes runs.
    - Run IDs are `scan~<workspace dir name>~<slug>`. On the zerg host, `/srv/agent-workspaces/*/merged` uses the session name.
    - An unreadable directory is reported in `sources` with `status: "unreadable"` and does not fail the list.
    - Path rebasing: a scanned run's state.json holds container paths (`repo: "/workspace"`, `history[].log` under `/workspace/...`). For scan runs, `findRun` sets `runDir` and `repoRoot` to host paths, `phi` from `<repoRoot>/.brewery.json`, and `writable` from an access check on `runDir`. Routes already read only those fields (T1). Container paths in state are rebased onto `repoRoot`, never opened as-is. `.brewery.json` (phi, routes) is read from `<repoRoot>/.brewery.json`.
    - PHI is opt-in for scanned runs, as for local runs: a run counts as PHI only when its workspace `.brewery.json` says `"phi": true` (D7).
    - A source whose run directories the server cannot write to is `status: "read-only"`, and its runs have `writable: false`.
  - Seam: `GET /api/runs` on the T1 server
  - Interface: `sources[]` entries `{id: "scan:<glob>", kind: "scan", status, detail?}`. Run entries carry `source: "scan"` and `workspace: <dir name>`.
  - Cases:
    - `<tmp>/ws1/merged` and `<tmp>/ws2/merged` each hold slug `feat` → two runs, `scan~ws1~feat` and `scan~ws2~feat`
    - The view, step, and events routes resolve `scan~ws2~feat` to ws2's run directory
    - (Skip the permission cases when uid is 0.) `<tmp>/ws3/merged` with mode 000 → listed in `sources` as unreadable, and the other runs still list
    - A glob that matches nothing → `sources` status `ok`, no runs
    - A workspace with `.terreno/brewery/` but no state.json → skipped
    - A scanned state.json with `repo: "/workspace"`, a step log at `/workspace/.terreno/brewery/feat/steps/001-pick-T1-claude.log`, and `<tmp>/ws1/merged/.brewery.json` `{"phi": true}` → the view's narration is empty, and the step route resolves the log under `<tmp>/ws1/merged/.terreno/...` (phi still withholds it, `phiWithheld: true`)
    - A workspace with no `.brewery.json` → not PHI, so narration is shown
    - The same workspace with `{"phi": true}` → narration and every free-text field are withheld
    - A run directory with mode 0555 (skipped as root) → the source is `read-only`, and `findRun` returns `writable: false`
  - Blast radius: `findRun` is used by every route → the T1 local cases still pass
  - Test skills: none

- [ ] **T11** — Show runs from other `brewery ui` instances in one view
  - Depends on: T10
  - Files: cli/src/ui/peers.ts, cli/src/ui/server.ts, cli/src/commands/ui.ts, cli/src/config.ts, cli/test/ui-peers.test.ts
  - Criteria:
    - `--peer <name>=<url>#<token>` (repeatable, or `ui.peers` in the global config) merges each peer's run list into this one, as `<name>~<peer run id>`.
    - Every per-run route, SSE included, is proxied to the peer, with its token added server-side. The browser never sees peer tokens.
    - A peer that fails or times out (3 s) shows `unreachable` in `sources`, and the local runs still list.
  - Seam: two real `startUi` servers in one test
  - Interface: `sources[]` entry `{id: "<name>", kind: "peer", status}`. Proxied routes return the peer's status code and body unchanged.
  - Cases:
    - Peer B has run `local~x` → A lists `zerg~local~x`, and `GET /api/runs/zerg~local~x` on A returns B's view
    - SSE through A for `zerg~local~x` → lines appended on B arrive through A in order, and `Last-Event-ID` is forwarded
    - POST answer through A → B's answer route handles it (the reply-file case)
    - B is stopped → A's list has `sources` `{id: "zerg", status: "unreachable"}`, and the local runs are still present
    - The page HTML and every response from A → contain no B token
    - A peer id with a wrong token at B → A reports the source `unreachable` with detail `401`
  - Blast radius: none (read-only, plus proxying answers that B checks)
  - Test skills: none

- [ ] **T12** — Build the dashboard page
  - Depends on: T6, T7, T9, T11
  - Files: cli/src/ui/page.html, cli/test/ui-page.test.ts
  - Criteria: one self-contained HTML file (inline CSS and JS, no CDN, no build step) that renders only `RunView`, step details, sources, and the event stream.
    - Left: the run list grouped by source, with phase, a "needs you" badge, a live dot, and source status.
    - Main: a pipeline strip (distill → cut → sign-off → barrel → finish) with the active stage lit.
    - A waiting banner with the message, asks, and an answer box. A 409 shows its `command` to copy. In a PHI run, the banner reads "N questions waiting. Read them at the terminal or in the IP", and keeps the reply box.
    - Task lanes: one row per task, with cards for each test, pick, and roast attempt, colored by verdict.
    - An "Active agents" grid: one card per running step (agent, stage and task, elapsed, live narration tail), with fan-out cards side by side.
    - Each card links to the cards it handed off to and from.
    - A routes table showing which agents run each stage, marked run or config.
    - Totals: time, tokens, and cost.
    - Clicking a card opens a drawer with T7's detail.
    - Light and dark themes, usable at phone width, and the stream reconnects with `Last-Event-ID`.
  - Seam: GET / on the T1 server
  - Interface: `GET /` → `text/html` (the embedded page). The page calls only `/api/runs`, `/api/runs/:id`, `/api/runs/:id/events`, `/api/runs/:id/steps/:seq`, `/api/runs/:id/answer`, and `/api/runs/:id/note`.
  - Cases:
    - GET / without the token → 200 (the page only, no data)
    - page.html calls `history.replaceState` to strip `token` from the URL, and sends the token only as `X-Brewery-Token`
    - Every `/api/...` path string in page.html is in the server's route table (no dead calls)
    - page.html has no `http://` or `https://` script or stylesheet src (self-contained)
    - page.html has `<meta name="viewport">` and a `prefers-color-scheme` block
    - `ui/server.ts` imports page.html `with { type: "text" }`, so it survives `bun build --compile`
    - Manual (BREW-new-1), because no process-layer test can observe them: the token leaving the address bar, reconnecting after a server restart, cards and handoff links rendering, fan-out side by side, phone layout (see Q9)
  - Blast radius: none
  - Test skills: none

- [ ] **T13** — Document `brewery ui`, handoffs, and running it on the zerg host
  - Depends on: T5, T12
  - Files: cli/README.md, README.md, plugins/brewery/skills/overview/SKILL.md, plugins/brewery/.claude-plugin/plugin.json, plugins/brewery/.cursor-plugin/plugin.json, plugins/brewery/.codex-plugin/plugin.json, .claude-plugin/marketplace.json, .cursor-plugin/marketplace.json, .agents/plugins/marketplace.json, docs/regression/brewery.md, cli/test/layout.test.ts
  - Criteria:
    - `cli/README.md` covers:
      - `brewery ui`: flags, the token, loopback, `--scan`, `--peer`, the phi behaviour, and how answering works (reply file, spawn, command);
      - `BREWERY_REPLY_WAIT_MIN` and the user-config `replyWaitMin` for zerg drones;
      - the `usage` and `handoff` kinds in the events table;
      - the handoff contract and routing table;
      - a "zerg host" section: the exact `brewery ui --host <tailnet ip> --scan '/srv/agent-workspaces/*/merged'` command, and the laptop `--peer` line.
    - The overview skill's "Pick one" table gains "Watch every run live → `brewery ui`".
    - BREW-new-1 is added.
    - Every manifest is bumped to the same new version.
  - Seam: skill and doc text (layout test)
  - Interface: n/a
  - Cases:
    - layout.test asserts the overview SKILL.md mentions `brewery ui`
    - layout.test asserts the cli/README events table lists `usage` and `handoff`
    - layout.test asserts the cli/README mentions `--scan` and `--peer`
    - every manifest carries the same new version
  - Blast radius: none
  - Test skills: none

Chain reasons:
- T2→T3→T4→T5: each pair shares a file. T3 and T4 both edit `agents.ts`, T4 and T5 both edit `prompts.ts`, and T3 emits T2's event type.
- T3→T8→T10→T11: T3 and T8 share `state.ts`, T8 and T10 share `config.ts`, and T10 and T11 share `commands/ui.ts`.
- T11→T12→T13: the page renders T11's sources.

## Rollout

1. Merge. The CLI change is backward compatible: no flags means no UI, `replyWaitMin` defaults to 0, and the handoff is optional.
2. On the zerg host, run `brewery ui` per the README's zerg host section. Running it as a user unit is X6.
3. Set `BREWERY_REPLY_WAIT_MIN=240` in the zerg image's environment (beside `BREWERY_SKILLS_DIR`), so drones stay answerable from the page. **Gate before step 2 puts the zerg-host instance on the tailnet:** confirm that every Flourish repo's `.brewery.json` on master has `"phi": true`, because PHI is opt-in (D7).

## Assumptions

- Security (not asked; set by brewery's PHI repos and the HIPAA boundary):
  - loopback by default, with an explicit `--host` for anything else;
  - a per-start token on every API call, plus `Host` and `Origin` checks;
  - JSON-only POSTs;
  - peer tokens stay on the server;
  - every event is scrubbed before it leaves the server;
  - PHI runs (`phi: true` in the repo's `.brewery.json`, opt-in per D7) show structure only. No narration, actions, messages, asks, prompts, log tails, results beyond status and counts, or handoffs (T1, T2, T7, T10).
- Port default 4848, host default 127.0.0.1, and the token comes from `crypto.randomUUID()`.
- SSE and reply pickup poll with `fs.stat` instead of `fs.watch`, because watch events are unreliable for appends under gVisor and on macOS.
- The page is vanilla JS with no framework, which keeps brewery dependency-free and compilable.
- The zerg host user (`josh`, in group `agentrun`) can read the files containers write under `/srv/agent-workspaces/*/merged/.terreno/`. Not verified. T10 reports unreadable roots, and BREW-new-1 checks the real host.
- Reply pickup through `reply.json` works for zerg runs, because the host and the container share the workspace. The UI on the host writes the file, and the drone inside the container reads it.
- The handoff caps (400 chars; 8 items × 200 chars; newest 6) are starting values, not tuned.

## Open questions (recommendation assumed)

| ID | Question | Recommendation | Why | If answered differently | Tasks affected |
| --- | --- | --- | --- | --- | --- |
| Q3 | Should handoff routing be a fixed table or chosen by a model? | A fixed table in `handoff.ts` | Deterministic, testable, and free, and every routed handoff is visible in the UI. Model-chosen context adds a step to every handoff and makes runs hard to replay | Add a `handoff` stage that reads candidate handoffs and writes the next step's brief. It needs a new config stage, and adds cost and latency per step | T5 |
| Q4 | Should the UI start runs (distill/pour/barrel/finish), or only watch, answer, and note? | Watch, answer, and note | Starting a run needs a checkout, a branch, and a long-lived process you would want in tmux or zerg anyway, and in zerg that means `zerg run`. Answering covers "waiting on me" | Add POST /api/runs to start commands detached locally, or through zerg for sessions. +1–2 tasks | T9, T12, new |
| Q5 | Should stage routing (which agents run each stage) be editable from the UI? | Read-only display | Routing already lives in `.brewery.json`, versioned per repo, and `--agents`. UI edits would make a second source of truth | A routes editor that writes `.brewery.json`. +1 task | T6, T12 |
| Q9 | Add a browser (Playwright) smoke test of the page in v1? | No. A manual regression case covers it in v1, and X1 adds the layer later | brewery's e2e guide has only the `process` layer. A browser layer is new test infrastructure in a dependency-free CLI | +1 task before T12: add a `browser` layer to docs/testing/e2e.md with one smoke spec (cards render, token stripped, reconnect). T12 then depends on it | T12, new |
| Q7 | Is token and cost tracking (T3) wanted in v1? | Yes | The UI option you picked listed "cost and time". The data is already on the agents' streams. It is one small task | Drop T3: T4 depends on T2 directly, and totals show time only | T3, T4, T12 |

## Expansions (follow up later)

| ID | Idea | Why it came up | Rough size | Depends on |
| --- | --- | --- | --- | --- |
| X1 | Browser e2e layer (Playwright) for the page | The page has no automated rendering test | M | T12 |
| X2 | Shade console view of brewery runs | You listed the Shade console as a UI option. Shade retired brewery in IP-027 | L | T11 |
| X3 | Cost budget per run, with a gate when it is exceeded | T3 makes cost visible | S | T3 |
| X4 | Desktop or ntfy notification from the page when a run starts waiting | A natural next step after the "needs you" badge | S | T12 |
| X5 | Start and stop runs from the UI | Q4 | M | T9 |
| X6 | A systemd user unit for `brewery ui` on the zerg host, in dotfiles | Rollout step 2 is manual | S | T13 |

## Decisions

| ID | Question asked | Answer | What it changes |
| --- | --- | --- | --- |
| D1 (durable) | Build on the brewery CLI, or a new harness? | Extend the brewery CLI | Everything lands in `cli/`. The step engine, routing, and gates are reused |
| D2 | Where should the live UI of all the agents live? | A local web dashboard served by `brewery ui` | T1, T6, T7, T9–T12 |
| D3 | What does "intelligently hands off context" mean? | Curated handoff briefs that each step writes and the harness routes forward | T4, T5, T7 |
| D4 | Must v1 show runs from zerg sessions? | Yes, one view of everything | Adds T8's reply pickup for drones, T10's workspace scan, and T11's peers. Rollout covers the zerg host |
| D5 | How should a zerg run be answered when its drone has already exited? | Show the command to run in that session | T9 returns 409 with `command`, and T12 shows it to copy. The zerg image sets `BREWERY_REPLY_WAIT_MIN` |
| D6 | How much of Pick's handoff does Roast see? | `files` and `traps` only, as claims to verify | T5's roast rows |
| D7 (durable) | How does the dashboard decide a run is PHI? | Fail open, opt in: a run is PHI only when its repo's `.brewery.json` says `"phi": true`, for local and scanned runs alike | T10 reads `phi` from the workspace's `.brewery.json` with default false. Rollout gates the tailnet exposure on every Flourish repo setting `"phi": true`. The planner recommended fail closed |
| D8 | Approve the plan on these answers, with the remaining open questions on their recommendations? | Approve (2026-11-05) | Q3, Q4, Q5, Q7, and Q9 stand on their recommendations |

## Sign-off

Status: approved 2026-11-05
Cut: 2 rounds, 22 findings: 18 fixed, 4 moved to questions (Q6 marked fundamental, Q7, Q8, Q9; Q6 and Q8 since answered as D5 and D7), 0 rebutted
