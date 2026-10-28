# Distilling — triage instead of grilling

Adapted from terreno Grow's `grilling.md`. Grow asks every human decision before writing.
Distill asks the few that would sink the plan if guessed wrong, and writes the rest down
with a recommendation. The human settles them at sign-off, or never, in which case the
recommendation stands.

## Triage every open question

| Kind | Test | Handling |
| --- | --- | --- |
| **Fact** | The repo, docs, git history, or a quick probe can answer it | Look it up. Never ask. |
| **Implementation detail** | Repository convention strongly implies the answer | Choose it. List it under Assumptions in the IP. |
| **Deferrable decision** | A human decision, but a wrong guess costs a few tasks' rework | Recommend, build on the recommendation, list it in Open questions. |
| **Fundamental decision** | See below | Ask now (in chat), or first in the sign-off (async). |
| **Expansion** | Scope beyond the request: adjacent features, cleanups, "while we're here" ideas | Park it in Expansions. Never put it in the task list. |

A decision is **fundamental** only when at least one holds:

- A wrong guess changes the destination: who it is for, or what exists when it is done.
- A wrong guess rewrites more than half of the task list, usually because it moves the
  tracer seam, data model, or public contract every later task builds on.
- A wrong guess is irreversible or unsafe to discover later: destructive migrations,
  data deletion, PHI exposure, auth or access-control boundaries, external
  commitments.
- Two options are close and lead to opposite designs, and research cannot break the tie.

Anything else is deferrable. When unsure, ask "if I build on my recommendation and the
human picks the other option at sign-off, what do I redo?" A few tasks is deferrable.
The plan is fundamental.

## Asking fundamental questions

- One round. At most four with the structured question tool, recommended option first
  and labelled `(Recommended)`, 2–4 concrete options per question.
- Put the context in the question: one or two sentences, citing what research found.
- Get to the bottom of vague answers ("sure", "your call") only for these questions.
  A vague answer to a fundamental question stays open.
- Never ask a second round of deferrable questions because the human seems available.

## IP bottom sections

These close every distilled IP, in this order, after the task list.

```markdown
## Open questions (recommendation assumed)

| ID | Question | Recommendation | Why | If answered differently | Tasks affected |
| --- | --- | --- | --- | --- | --- |
| Q1 | <the question as you would ask it> | <the choice the plan is built on> | <one line, cite evidence> | <what changes> | T2, T4 |

## Expansions (follow up later)

| ID | Idea | Why it came up | Rough size | Depends on |
| --- | --- | --- | --- | --- |
| X1 | <scope beyond this request> | <what surfaced it> | S / M / L | <task or decision> |

## Decisions

| ID | Question asked | Answer | What it changes |
| --- | --- | --- | --- |

## Sign-off

Status: draft | awaiting sign-off (sent <date> via <channel>) | approved <date>
Cut: <rounds> rounds, <n> findings: <edited> fixed, <moved> moved to questions or expansions, <rebutted> rebutted
```

Rules:

- Mark fundamental questions `Q1 (fundamental)` and list them first.
- "If answered differently" is required. It is what lets the human judge a question
  without reading the plan.
- A question answered in chat goes straight to Decisions and never appears in Open questions.
- Expansions are not promises. `barrel` never builds them.
- Empty sections stay with a single `None.` line so the human can see nothing was hidden.
- Mark a Decisions row `D2 (durable)` when the answer should outlive this plan: an
  architecture choice, a convention, "we don't use X". brewery copies it to
  `docs/decisions/` at the end of the run and replaces the marker with a link. Most
  decisions are about this plan only and stay unmarked.

## The brief (top of the IP)

The IP opens with a standalone brief, because the sign-off link lands here:

```markdown
# <Change title>

<Orientation: three to five sentences on where the repository is, where this takes it,
why now, and who feels the difference. No paths, no task IDs.>

## The idea

<The contract, model, API, or seam that changes, and what is observably different.
One line on the rejected alternative when a reviewer would ask.>

## The plan

| # | Task | Depends on | Lands in | Proves it |
| --- | --- | --- | --- | --- |

Tracer: <seam the first task cuts through>
E2E: <planned specs and layers, e.g. "2 specs (browser, http)"; or "None — reason">
Regression: <provisional case IDs and destination suite; or "None — reason">
User guide: <guide pages added, updated, or retired; or "None — reason">
Design: <canvas link and the artboards the plan builds; or "None — reason">
Out of scope: <tags; see Expansions>
Open risks: <none, or one line each>
Elephant: <the likeliest risk nobody has raised, in one line; or "none">
```

`Open risks` are the ones the plan already names. `Elephant` is the one nobody has said
out loud: a migration, a cost, a dependency on a person, an assumption everyone is making.
Write `none` only when there honestly is none. Never invent one to fill the line. The
sign-off message carries it, so it must make sense without the IP.

## Testing sections (after the brief)

The two testing sections follow the brief, before the task list, in the format of
[`testing plan`](../../terreno-shared/testing-plan.md), then `## User guide` in the format
of [`user guide`](../../terreno-shared/user-guide.md), then `## Design` in the format of
[`designing`](designing.md#the--design-section). Each may be `None — <reason>`.
None may be missing, and a bare `None` with no reason is a defect cut blocks on.

```markdown
## E2E tests

| ID | Spec or flow | Layer | Proves | Written in |
| --- | --- | --- | --- | --- |
| E1 | <path the e2e guide prescribes> | <a layer from the guide> | <criterion, in observable terms> | T2 |

## Regression cases

Destination: <AREA> → <regression suites>/<area>.md

| ID | Case | Steps | Expected | Platforms | Automated by | Added |
| --- | --- | --- | --- | --- | --- | --- |
| <AREA>-new-1 | <case> | <starting state, then action> | <what is observable> | <platforms> | E1, or manual | <IP slug> |

## User guide

| ID | Page | Change | Audience | Written in |
| --- | --- | --- | --- | --- |
| G1 | <user guide>/<area>/<feature>.md | new, update, or retire | user, admin, or staff | T2 |
```

Rules:

- Every UI or cross-process acceptance criterion has an `## E2E tests` row, written in
  the task that delivers its behaviour, or the section says why it has none.
- `## Regression cases` is usually `None — no hard-to-automate change`. A case is only
  for what a developer or QA must check by hand (push notifications and other hardware
  or OS behavior, a full cross-device flow, feel) and no existing case covers.
- Every acceptance criterion that changes what a user sees or does has a `## User guide`
  row, written in the task that delivers its behaviour, or the section says why it has
  none (`None — no user-visible change`). A repository whose `## User guide conventions`
  table says `none` writes `None — user guide off`.
- Regression IDs stay provisional (`<AREA>-new-<n>`), with one `Destination:` line per
  prefix. Brew assigns the real IDs. A row that edits an existing case keeps its real ID.
- The `E2E:`, `Regression:`, `User guide:`, and `Design:` brief lines summarize these sections. They stay lines
  under the plan table, not headings.
- An IP approved before the contract reads a missing section as
  `None — predates contract`.

The detailed task list, Assumptions, and the bottom sections follow. Write each task as one
line in exactly this format, with its details in an indented block.
`brewery` parses these lines to track and commit each task, and uses the title as the
commit subject. In that block, `Depends on:` declares task dependencies, with or without
a bullet, case-insensitively. Separate task IDs with commas and/or `and`; use `none`
for an independent task. The block ends at the next task, heading, or unindented prose.
A missing dependency line means the previous task in IP order; the first task defaults
to no dependencies. Graph validation reports unknown IDs, self-dependencies, and cycle
paths. A not-done task is ready when all its dependencies have landed on the feature
branch; checking a dependency's box alone does not count as landing:

```markdown
- [ ] **T1** — Add the cursor field to the reports API
  - Depends on: none
  - Files: reports API
- [ ] **T2** — Use the cursor in the reports client
  - Depends on: T1
  - Files: reports client
```

## The test brief

Every task carries a test brief in its details block. A separate test writer reads only the
brief, the task's criteria, and the IP's brief and Decisions, then writes the task's tests
before anyone implements it. It never sees the implementation, so the brief is all it knows.
Write it so a tester who has never seen this conversation could write thorough tests:

```markdown
- [ ] **T2** — Page the reports list with a cursor
  - Depends on: T1
  - Files: backend/src/api/reports.ts, backend/src/api/reports.test.ts
  - Seam: GET /reports (HTTP route)
  - Interface: `GET /reports?limit=<n>&cursor=<id>` → `{data: Report[], next: string | null}`,
    exactly those fields (each Report: `_id`, `title`, `created`); staff only
  - Cases:
    - 3 reports, limit 2 → data r1, r2; next = r2's id
    - cursor = r2's id → data r3; next null
    - cursor of a deleted report → 400 `{title: "Invalid cursor"}`
    - limit 0 or 101 → 400
    - patient user → 405 (list permission); no token → 401
  - Blast radius: report deletion reads the same index → backend case in reports.test.ts
  - Test skills: terreno-backend-tests
```

- **Seam**: the highest public seam that proves the behavior (HTTP route, exported
  function, rendered component, adapter contract), per the testing guidance.
- **Interface**: what a caller writes and gets back, precise enough to code a test against
  before it exists: signature or route, inputs, output shape, errors, who may call it.
- **Cases**: worked examples with literal inputs and expected values. Include the edge
  cases that matter: empty, missing, and invalid input; boundaries; permissions with exact
  statuses; loading and error states for UI. A writer with only "handles errors" has
  nothing to assert.
- **Blast radius**: for a task that changes state, the consumers that read it and the layer
  each case belongs to, traced per the testing guidance's
  [blast radius](../../terreno-shared/testing.md#blast-radius) method. `none` when the task
  changes no state another behavior reads.
- **Test skills**: the repository skills that say how to write tests at this seam. In
  Terreno apps, `terreno-backend-tests`, `terreno-frontend-tests`, or
  `terreno-mobile-tests`. Their tables decide the layer and the exact permission statuses
  (401 no token, 405 method permission, 403 object permission, 404 missing id), so Cases
  name statuses from them. A route that returns user or PHI data lists its exact response
  fields in Interface, so the test can pin the shape.

A layer with no test setup yet (no preload, `bun test` finds nothing) gets its own first
task, built with `terreno-test-setup`, which the other tasks depend on. The test step
writes only tests, so it cannot add setup itself.

A task whose criteria no test can observe (prose, config with no behavior) says
`Cases: none (untestable: <why>)`. Roast checks the claim.

## Splitting for a parallel build

Put the tracer first: the smallest end-to-end behaviour that proves the main seam.
Then split the remaining work into small, composable tasks. Each task is one
independently testable behaviour that can be roasted on its own; split any task that
needs more than one roast-able behaviour.

Every task carries `Depends on:` (`none` or task IDs) and `Files:` (every file it
writes, comma-separated, including shared registries, barrels, and route or tool
indexes). Declare the real prerequisites, rather than depending on the previous task
by habit: depend on a task only when this one reads or extends something it creates.
Two tasks that share a file depend on each other, so their writes are ordered; brewery
also refuses to build two tasks with a shared `Files:` entry at once. Prefer wide over
deep: fan out independent tasks and keep dependency chains short. A chain longer than
three needs a reason for each link. Use a join task only when a behaviour requires the
branches to be complete.

For example, after a tracer adds a reports API, a reports client and an export utility
can both depend on the tracer if they write different files. If both write the same
client file, order them with a dependency. Cut attacks false independence, tasks that
contain multiple behaviours, and chains that could fan out.

## Anti-patterns

- Asking a deferrable question because it is easy to ask
- Blocking the draft on a fundamental question while the human is away, when you could
  write it on your recommendation and flag it
- Building an expansion "because it was small"
- Open questions without a recommendation, or without "If answered differently"
- A UI criterion with no planned spec, or a testing section that says only `None`
- A UI task with no `Design:` line when the IP has a design, or a canvas change applied
  without saying what it became
- A sign-off message that needs the IP open to make sense
- Treating silence as sign-off
