# Lifecycle contract

Grow, Pick, Roast, Brew, and Taste are **transitions**, not the orchestration loop.
`terreno-pick-roast-loop`, `terreno-planning-loop`, and `terreno-taste-sweep` are
invocable outer loops; they must not be recorded as `stage` values.

| Owner | Responsibility |
| --- | --- |
| Outer loop | when to invoke, which agent, persistence, Taste `PENDING` reinvocation, retry, stop, escalation |
| Pick–Roast inner loop | one task Pick, Roast that task, next task, until the list is done |
| Lifecycle stage | how to perform one stage correctly and emit evidence |
| Repository skills | repository commands, architecture, safety rules, and domain conventions |
| Roast | whether the implementation satisfies the approved IP |
| State + evidence | what a fresh invocation needs from previous attempts |

Every stage reads durable inputs, performs one bounded transition, writes the execution
state, emits one result document, and exits. Never rely on conversational memory.
Pick is the exception that still stays bounded: it continues the
[`pick-roast loop`](pick-roast-loop.md) in-process (one task, then Roast, then the next
task) until the approved list is done, a `FAIL` that cannot continue, or `BLOCKED`.
Roast never invokes Pick. Roast proves the current task and returns. Brew and Taste
include one in-process wait for
[`async review bots`](async-review-bots.md) (Bugbot, CodeQL, and similar) before that
exit, so they can react to those results. Taste then waits in-process for product CI
with [`product-ci.md`](product-ci.md) on every discovered host, using GitHub CLI or
CircleCI CLI in a watch loop until jobs are terminal or the wait times out. Before any
push, Taste fetches the latest `master` and merges it only when the PR conflicts, a failure
traces to base drift, or the branch is otherwise merge-ready, then records last-run failed
tests from the CI snapshot and re-verifies them locally, then spawns a fresh subagent
with no parent conversation. The subagent runs the root package's `prepush` script when
present; that script is the repository-owned gate for lint, typecheck, static analysis,
tests, and other local policy. When it is absent, Taste falls back to lint, typecheck,
and locally affected tests in each affected package. Taste then pushes and watches
product CI. Hosts and tokens are on the product-CI page.

## Discover supporting skills

At the start of every stage:

1. Inspect skills exposed by the harness and repository (for example skill catalogs and
   repository skill directories).
2. Match their descriptions to the **files and criteria in this slice**, not the whole
   catalog.
3. Load applicable `SKILL.md` files before acting. Record their names in `skills`.
   Do not load sibling lifecycle references this stage did not name.
4. If repository instructions require a capability and it is unavailable, return
   `BLOCKED`; never silently skip it.
5. If no skill applies, infer conventions from repository instructions, existing code,
   tests, package scripts, and recent analogous changes.

Do not assume any particular supporting skill name exists. Lifecycle skills describe
portable method; repository skills describe the repository.

When spawning a fresh subagent, pass a [task-scoped briefing](subagent-briefing.md)
instead of asking the child to rediscover the repository.

## Documentation

Every stage follows the [`documentation contract`](documentation-contract.md):

- Read architecture and domain docs before acting.
- Treat docs as the architecture source; code implements them.
- Update docs in the same slice as the behavior.
- Write with standard headings, tables, and one minimal example.
- Missing docs for a user-visible or architectural change is `FAIL`.

## Stage result

Machine-readable result is for the next skill and the outer loop. It is **not** the
human-facing answer.

Lead the chat with `status`, `next`, and `action` in one or two lines. Put the YAML
only in a collapsed details block. On a PR, put it only in the Details toggle from the
[`GitHub attention contract`](github-attention-contract.md). Never paste the YAML in
visible PR body, comments, or the main chat.

When a PR has GitHub Deployments, close every wait-for-human or done message with those
demo URLs as the **last visible section**, per [`pr-deployments.md`](pr-deployments.md).
Omit the section when no `environmentUrl` exists. Do not comment the links on the PR.

The schema is [`stage-result.schema.json`](stage-result.schema.json) (`v: 2`). Required
keys are `v`, `stage`, `status`, `next`, and `action`. Omit nulls and empty arrays.
Status values are exactly `PASS`, `FAIL`, `BLOCKED`, or `PENDING`.

Wrap the YAML:

```html
<details>
<summary>Stage result</summary>
</details>
```

Example payload:

```yaml
v: 2
stage: roast
status: FAIL
ip: example-feature
task: T2
attempt: 2
sha: abc123
checks:
  - name: cursor-pagination
    status: FAIL
    ev: "bun test: expected 2 records, received 3"
fail:
  - need: Cursor pagination is backwards compatible
    want: No duplicate records across pages
    got: Final page repeats one record
    ev: test output
next: pick
action: Fix duplicate cursor boundary and rerun the failing test
```

Evidence in `ev` must be reproducible: command plus outcome, artifact path, API
response, log location, or PR/check URL. Never persist chain-of-thought or conversational
transcripts.

| Key | Meaning |
| --- | --- |
| `sha` | current head |
| `skills` | supporting skills loaded |
| `done` | completed work |
| `fail` | `need` / `want` / `got` / `ev`; optional `sev` |
| `block` | `kind` / `why` / optional `ev` |
| `ask` | human questions: `q` / `rec` / optional `opts` |
| `next` | recommended next stage or `null` |
| `action` | concrete next action |
| `wait` | seconds until the next Taste check (`PENDING` after bot timeout, product-CI wait timeout, or a second post-fix push) |

## Execution state

The IP and task file remain authoritative for design and scope. Execution state is a
small loop-owned handoff, not another plan.

The focused Pick–Roast outer loop may add the schema-defined `ledger` array. Each entry
records one Pick or Roast task attempt, head, status, summary/evidence, and optional
files, checks, artifacts, docs, hypothesis, and risks. It is the source for the single
completion or human-gate report.

Use an existing repository convention when present. Otherwise use
`.terreno/pipeline/<ip-or-task-slug>.json`, conforming to
[`execution-state.schema.json`](execution-state.schema.json). The outer loop must preserve
or transport this file between fresh invocations. Do not commit it unless the repository
explicitly tracks execution state; Brew must exclude loop-owned state from PR commits.

Each invocation:

1. Read state and verify its branch/sha/PR against reality.
2. Increment `attempt` for the invoked stage.
3. Consume `last` and prior `tried` approaches; do not repeat a failed approach
   without new evidence.
4. Perform the stage.
5. Replace `last`, merge artifact references, and set `next`.
6. Emit the same result to the caller so the loop can persist it elsewhere.

When `terreno-pick-roast-loop` is driving, append the schema-defined `ledger` entry
between steps 5 and 6.

These six state operations are mandatory whenever a stage says “update execution state.”
Every result also includes a concrete `action`, even when `next` is `null`. For
`BLOCKED`, set `next.human: true` only when the blocker is a human decision/policy gate;
access/environment/external blockers remain false unless human action is genuinely
required.

If no writable artifact exists, still emit the result. If the outer loop cannot preserve
that result for the next fresh invocation, return `BLOCKED` and name the missing state
transport.

## Failures, blockers, and retries

- `FAIL`: objective engineering or verification failure. Preserve exact evidence and
  recommend the smallest evidence-driven retry.
- `BLOCKED`: no safe engineering action exists now. Classify `human`, `environment`,
  `access`, or `external`; include the exact action or decision required.
- `PENDING`: changing external state is not terminal (primarily Taste). Include `wait`;
  the **outer loop** waits and invokes again. With no outer loop (a human invoked
  Taste or Brew directly), Taste's standalone entry waits and reacts again itself.
  `PENDING` is never the final answer to a human. Use `PENDING` for review-bot timeout,
  product-CI wait-loop timeout (jobs still pending on GitHub Actions, CircleCI,
  Buildkite, and similar), and after Taste's second post-fix push. Do not emit
  `PENDING` while Bugbot, CodeQL, or similar review bots are still queued or in
  progress; wait per the async-review-bots procedure first. Do not emit `PENDING` for
  unfinished product CI until Taste has run the product-CI wait loop to completion or
  timeout, preferring `gh` / `circleci` watch hooks.
- `PASS`: this stage's success conditions are proven for the recorded head.

Human gates include unresolved product semantics, architecture/security/data ownership,
destructive or irreversible operations, permissions, public compatibility, significant
scope growth, and policy-required approval. Include options, tradeoffs, evidence, and a
recommended default when appropriate.

An outer loop requesting human input must first summarize the overall plan state,
completed work, failed/recovered attempts, decisive evidence, options and impact, and a
recommended default. It ends with one exact question, then the Demo section when the PR
has deployment URLs. Objective engineering failures are not human gates while a concrete
safe action remains.

Bounded engineering retries must be hypothesis-driven. Taste waits in-process for
async review bots and for product CI (bounded watch loop). The outer loop reinvokes
Taste after `PENDING`. Brew waits in-process only for async review bots.
