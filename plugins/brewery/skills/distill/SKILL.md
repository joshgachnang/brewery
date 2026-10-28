---
name: distill
description: Shape a request into an implementation-ready IP and task list with minimal back-and-forth, like terreno Grow but with triage instead of grilling. Asks only questions fundamental to the feature, records every other question with its recommendation at the bottom of the IP, parks expansions for later, attacks the draft with `cut`, fixes it, then sends the IP for async sign-off over Slack, text, or email. Use when asked to distill, plan, or spec a feature for later execution by `barrel`; not for implementation.
---

# Distill — shape with little grilling

Turn a request, ticket, or spec into an IP a fresh `barrel` run can execute without the
conversation. Terreno Grow grills every human decision before writing. Distill asks only
the questions a wrong guess would ruin, writes the plan on its recommendations, and puts
everything else in front of the human once, at sign-off.

Read before acting:

- [`distilling`](references/distilling.md): triage, IP bottom sections, sign-off brief
- [`testing plan`](../terreno-shared/testing-plan.md): the e2e guide's spot and the two required testing sections
- [`user guide`](../terreno-shared/user-guide.md): the end-user guide's spot, its opt-out, and the required `## User guide` section
- [`designing`](references/designing.md): the Claude Design canvas, what a run may add to it, the checkpoints, the `## Design` section, and the snapshot
- [`lifecycle contract`](../terreno-shared/lifecycle-contract.md) (stage results and execution state)
- [`documentation contract`](../terreno-shared/documentation-contract.md)
- [`reaching the human`](../terreno-shared/reaching-the-human.md)

## Run it with brewery

`brewery distill "<request>"` runs this as separate agent processes (Claude, Codex, or local models via
litellm). brewery runs cut in a clean worktree, owns the `Status:` line, and
collects the sign-off reply with `brewery answer <slug> "ok"`. Source: `cli/` in [brewery](https://github.com/joshgachnang/brewery). Use this skill directly for an
interactive, single-session run.

## Inputs

- Request, ticket, or spec and linked context, verbatim
- A Claude Design link, the `Design:` line of a recipe issue, or a canvas named in an
  existing `## Design` section, with its snapshot
- Existing IP and task files when revising
- Repository instructions, architecture docs, code, tests, history, project skills
- Execution state and any "Prior human answers" preamble (from zerg or a pasted reply)

## Procedure

1. **Reconstruct.** Use the repository's IP convention. Otherwise use
   `docs/plans/YYYY-MM-DD-<slug>.md`, with the task list in the same file, and state at
   `.terreno/pipeline/<slug>.json`. If an IP already says `awaiting sign-off` and a reply
   has arrived, jump to step 11. An IP approved before the testing-plan contract reads a
   missing testing section as `None — predates contract`; revising it adds both sections.
   The same holds for a missing `## User guide` or `## Design` section.
2. **Read architecture docs** for the affected area. The IP must resolve docs that are
   missing or contradict the code. Resolve the e2e guide, regression suites, and smoke
   command from the agent instructions' `## Testing conventions` table or the defaults
   (`docs/testing/e2e.md`, `docs/regression/`), then read the guide and the area's suites.
   Resolve the `User guide` path from the `## User guide conventions` table or the
   default (`docs/user-guide/`) and read the area's pages, unless the value is `none`.
   Read the design per [`designing`](references/designing.md#reaching-the-canvas): the
   canvas the request, its issue, or an existing `## Design` section names, and its
   snapshot when one exists.
3. **Discover supporting skills** relevant to the affected files and record them.
4. **Research.** Answer every discoverable fact yourself, with explore subagents in
   parallel. Never ask the human something the repo, docs, or git history can answer.
5. **Triage** every open question per [`distilling`](references/distilling.md):
   fundamental, deferrable, expansion, or implementation detail. With a design, this is
   the first [checkpoint](references/designing.md#checkpoints): add `Draft —` artboards
   for missing screens and a sticky per open question about a screen.
6. **Ask only fundamental questions.** One round, at most four, each with a recommended
   option. When the human is in the chat, use the structured question tool and wait.
   When the human is not in the chat, do not block: write the IP on your
   recommendation, mark the question fundamental, and it goes first in the sign-off.
   With no fundamental questions, skip straight to writing. A question about a screen
   goes on the canvas too, as two option artboards the question names.
7. **Shape.** Contracts, models, and APIs before implementation detail. Scope, non-scope,
   architecture decisions, risks, rollout, dependencies. Put the tracer first, then split
   work into the smallest independently testable behaviours, each roast-able on its own.
   Split any task that needs more than one roast-able behaviour. Prefer wide over deep:
   fan out independent work and keep dependency chains short. Tasks that share a file
   depend on each other, so their writes are ordered.
8. **Specify proof.** Every acceptance criterion is observable and names its verification
   method. "Manual check" is not one. Give every task a test brief (Seam, Interface,
   Cases, Blast radius, Test skills) per [`distilling`](references/distilling.md#the-test-brief):
   its tests are written before its implementation by a writer who sees only the brief.
   For a task that changes state, trace the blast radius and put each consumer's case at
   its layer. Pair each UI or cross-process criterion with a planned spec at the path and
   layer the e2e guide gives, written by the task that delivers the behaviour, or state
   why it has none. Automate first: anything a guide layer can drive and assert is an e2e
   row. Regression cases are usually `None — no hard-to-automate change`: add one only for
   something a developer or QA must check by hand (push notifications and other hardware
   or OS behavior, a full cross-device flow, feel) that no existing case covers, each
   meeting the testing plan's regression-step bar. Pair each criterion that changes what a
   user sees or does with a `## User guide` row (new, update, or retire) per the
   [`user guide`](../terreno-shared/user-guide.md) contract, or state why it needs none.
   Give each UI task a `Design:` line naming the artboards it builds; their states
   become Cases and e2e rows.
9. **Write** the IP: the brief on top, then `## E2E tests` and `## Regression cases` per
   [`testing plan`](../terreno-shared/testing-plan.md) and `## User guide` per
   [`user guide`](../terreno-shared/user-guide.md), then `## Design` per
   [`designing`](references/designing.md#the--design-section) (each may be
   `None — <reason>`, none may be missing; a repository whose `## User guide conventions`
   table says `none` writes `None — user guide off`), then the tracer first and the
   small, parallel-ready task list (criteria, blockers, verification, docs, supporting skills). When no file
   exists at the resolved e2e guide path, add a task that writes it there, and make every
   task that writes a planned spec depend on it. Every task carries `Depends on:` (`none`
   or task IDs), `Files:` (the files or seams it touches), and its test brief. Follow
   the task list with the bottom sections from [`distilling`](references/distilling.md): Open questions,
   Expansions, Decisions, Sign-off. Build the plan on the recommendations. Set
   `Status: draft`.
10. **Cut, then fix.** Invoke the `cut` skill with the IP path and the user-context packet
    it describes. Cut only reports findings. For each one, pick the fix:
    - edit the IP and task list so it holds;
    - move it to Open questions with a recommendation, when it is a human decision;
    - move it to Expansions, when it is new scope;
    - rebut it in one line with evidence (a file, a quote from the human), when the
      attack is wrong.

    A `Couldn't assess` line is unchecked, not passed: check it yourself, or record it in
    Assumptions or Open questions. `Well-reasoned` lines need nothing.

    Blocking findings must all be edited, moved, or rebutted. When any blocking finding
    changed the plan, run `cut` once more on the new draft. Stop after two cut rounds and
    carry anything left into Open questions. Record the tally in the Sign-off section.
11. **Sign off.** With a design, write the
    [snapshot](references/designing.md#the-snapshot) to `docs/specs/<slug>/design/` and
    record the canvas version in `## Design` first. Set `Status: awaiting sign-off` and
    send the sign-off message per
    [`reaching the human`](../terreno-shared/reaching-the-human.md): fundamental questions
    first, then the open questions whose answers would change the most, with a link to
    the IP for the rest, and the canvas link when there is one. Add one `Elephant:` line
    after the summary, copied from the brief: the likeliest risk nobody has raised, or `none`. Never invent one. Emit `BLOCKED` (`stage: grow`, `next: null`,
    `block: [{kind: human}]`, one `ask` per question in the message) and stop.
12. **Apply the reply.** When answers arrive, move each answered question from Open
    questions to Decisions. Where an answer differs from the recommendation, rewrite the
    affected tasks and criteria, and run `cut` once more if the change is structural.
    A canvas that changed since the snapshot is a reply too: apply each change per
    [`designing`](references/designing.md#applying-canvas-changes), rewrite the snapshot,
    and list what each change became. A reply that rejects the plan returns to step 5
    with the reason. When the human has approved, set `Status: approved <date>`, update execution state, and emit `PASS`
    with `next: pick`. The next step is `barrel`.

Do not set `approved` without an explicit approval from the human. Remaining Open
questions are fine at approval: `barrel` builds on their recommendations.

## Success

- A reviewer with only the sign-off message and the IP can approve or push back.
- A fresh `barrel` run can find the next task, its criteria, decisions, assumptions, and
  skills in the IP alone.
- Every question the human did not answer is visible at the bottom of the IP with the
  recommendation the plan assumed.

## Failure and blocked

- Malformed or contradictory artifacts: `FAIL`, `next: grow`, exact defects.
- Waiting on sign-off or a fundamental answer: `BLOCKED`, `next: null`, with asks.
- Missing access or evidence that research cannot recover: `BLOCKED` with the exact action.
