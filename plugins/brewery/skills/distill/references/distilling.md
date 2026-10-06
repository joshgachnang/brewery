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
Out of scope: <tags; see Expansions>
Open risks: <none, or one line each>
```

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

## Splitting for a parallel build

Put the tracer first: the smallest end-to-end behaviour that proves the main seam.
Then split the remaining work into small, composable tasks. Each task is one
independently testable behaviour that can be roasted on its own; split any task that
needs more than one roast-able behaviour.

Every task carries `Depends on:` (`none` or task IDs) and `Files:` (the files or seams
it touches). Declare the real prerequisites, rather than depending on the previous
task by habit. Two tasks that share a file depend on each other, so their writes are
ordered. Prefer wide over deep: fan out independent tasks and keep dependency chains
short. Use a join task only when a behaviour requires the branches to be complete.

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
- A sign-off message that needs the IP open to make sense
- Treating silence as sign-off
