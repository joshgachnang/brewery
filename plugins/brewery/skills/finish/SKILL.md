---
name: finish
description: Loop terreno Taste on a PR until it has no merge conflicts, every CI job on every host passes on the current head, and every review-bot comment is answered. Waits on CI and review bots with native watches, fixes branch-caused failures, merges the base when it conflicts, reruns flaky jobs, and escalates to the human after three fix rounds that leave the PR red. Never stops quietly on a red PR. Invoked by `barrel` after Brew, or standalone any time later (e.g. after master moves) with an optional PR number. Not for merging.
---

# Finish — Taste until green

Each pass is one Taste reaction, per [`taste.md`](taste.md). This skill owns the repeat,
the stop condition, and the bounds. Those replace taste.md's Standalone entry section.

Read [`taste.md`](taste.md), [`product CI`](../terreno-shared/product-ci.md),
[`async review bots`](../terreno-shared/async-review-bots.md),
[`push ownership`](../terreno-shared/push-ownership.md), and
[`reaching the human`](../terreno-shared/reaching-the-human.md).

## Run it with brewery

`brewery finish [pr]` runs this as separate agent processes (Claude, Codex, or local models via
litellm). brewery does the CI waiting itself with `gh`, so no model runs while
CI is pending, and it starts one Taste agent per red snapshot. Source: `cli/` in [brewery](https://github.com/joshgachnang/brewery). Use this skill directly for an
interactive, single-session run.

## Setup

- PR: the argument, or `gh pr view --json number` for the current branch. No PR → stop
  and point to `barrel` or Brew.
- State: `.terreno/pipeline/<slug>.json` when present. Otherwise create one keyed by
  the branch name.
- Check out the PR branch at its remote head. Refuse to run on a dirty tree that is not
  yours.

## Loop

Repeat until a stop condition:

1. **React.** Run one Taste reaction against the current head: wait for review bots and
   product CI, snapshot, record last-run failed tests, act once, run the pre-push gates,
   push, and watch.
2. **Handle flakes.** When a failure is not branch-caused (it fails on the base too, is a
   known flake, or is an infrastructure error in the log), rerun only the failed jobs:
   `gh run rerun <run-id> --failed`, or CircleCI's rerun-from-failed. A rerun counts as a
   fix round. Never push code for a failure the branch did not cause.
3. **Check done.** On the current head:
   - `gh pr view <pr> --json mergeable,mergeStateStatus` is not `CONFLICTING` or `DIRTY`
   - every job on every discovered CI host is terminal and passing, or has a documented
     not-applicable skip. Pending is never passing.
   - every review-bot thread is fixed and resolved, declined with a one-sentence reply
     and resolved, or open only as a human decision
     ([`push ownership`](../terreno-shared/push-ownership.md#bot-comments)).
   If all three hold → **done**, even when human review threads are still open (see
   Report).
4. **Wait, then repeat.** On `PENDING`, wait on a native watch (`gh pr checks <pr>
   --watch`, `gh run watch`, `circleci run watch --sha <sha>`) run in the background, or
   a scheduled wakeup. Then start a fresh reaction from step 1. Never reuse conclusions
   from an older head.

Merging the base follows taste.md: only on conflict, base drift, or the final pre-merge
update. A conflict that needs a behavior choice is a human gate.

## Bounds

Stop `BLOCKED` and escalate per
[`push ownership`](../terreno-shared/push-ownership.md#escalation) when:

- 3 fix rounds (fix pushes plus flaky reruns) in this run left the PR red
- the same failing test or job survives two fix rounds with no new hypothesis
- 4 hours of cumulative waiting on CI and bots

Do not start a fourth round. Reach the human per
[`reaching the human`](../terreno-shared/reaching-the-human.md) as a blocker, not a
notice, and start the final message with `BLOCKED — PR #<pr> still red after <k> fix
rounds`. The message names the head, the failing or pending jobs with log links, what
each round changed, unanswered bot threads, and the one action needed. Never exit
quietly on a red PR.

## Report

`PASS — PR #<pr> at <sha>: no conflicts, CI green on <hosts>, bot comments answered.`
Then fixes pushed, reruns used, and every human review thread still unresolved. Mark the ones that need a human
decision as questions, per [`reaching the human`](../terreno-shared/reaching-the-human.md).
Close with PR deployment URLs. Never merge.
