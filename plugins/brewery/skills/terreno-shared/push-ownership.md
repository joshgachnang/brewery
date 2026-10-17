# Push ownership

A push hands a PR to CI and review bots. It does not finish the work. Every skill that
pushes to a PR branch follows this contract, whether it runs alone or under an outer loop.

## The rule

Whoever pushes owns the PR until it reaches one of two outcomes:

1. **Clean.** On the current head, every product-CI job on every discovered host is
   terminal and passing (or a documented skip), the PR has no merge conflict, and every
   review-bot comment is addressed (see [Bot comments](#bot-comments)).
2. **Escalated.** Three fix rounds did not make it clean, or a genuine human gate blocks
   the fix, and the human was told (see [Escalation](#escalation)).

Never end a skill, a turn, or a session with a pushed head that is red, still pending, or
carrying unaddressed bot comments while nothing is watching it. "Push and see what CI
says" is a defect. A stage that stops before the PR is clean hands off to a stage that
continues: Brew → Taste, Taste `PENDING` → the outer loop or Taste's own standalone
repeat. A stage that cannot hand off escalates.

## Fix rounds

One round is: observe a red snapshot → reproduce locally → fix (or rerun a failure proven
not to be branch-caused) → pre-push gate → push → wait for review bots and product CI on
the new head → observe again.

- Count rounds per PR across Taste reactions in one run. Record each round as a Taste
  `ledger` entry in execution state, so a fresh Taste or outer-loop process continues
  the count instead of restarting it.
- Rounds 1–3: keep going. Each round must carry a new evidence-based hypothesis.
- After round 3 the PR is still not clean → stop and escalate. Do not start round 4.
- Escalate before round 3 when the same failure survives two rounds with no new
  hypothesis, or when no safe fix exists.
- Waiting on pending CI or bots is not a round. Slow CI is not a reason to stop.

## Bot comments

A bot is any automated reviewer: Cursor Bugbot, CodeQL and code scanning, Copilot review,
Codex review, CodeRabbit, Sonar, dependency or security scanners, and similar. In GitHub's
API their `author.__typename` is `Bot`, or the login ends in `[bot]`.

Every bot review thread and every bot finding on the PR ends in exactly one state:

| State | Do |
| --- | --- |
| **Fixed** | Push the fix, then resolve the thread. Resolve silently when the diff explains it. |
| **Declined** | Reply in the thread with one sentence: false positive, intended behavior, or out of scope (link the follow-up issue). Then resolve it. Dismiss code-scanning alerts with the matching reason. |
| **Human decision** | Reply with **Action needed:** and one question. Leave it open and include it in the escalation. |

"Non-actionable", "informational", "nit", and "not from this branch" are not reasons to
leave a bot thread open without a reply. A PR with an unresolved, unanswered bot thread
is not clean. Top-level bot summaries (coverage, preview deploys) need nothing unless
they report a failure or finding.

List unresolved threads and their authors:

```bash
gh api graphql -f query='
  query($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100) {
          nodes { id isResolved comments(first: 1) { nodes { author { __typename login } path line body } } }
        }
      }
    }
  }' -F owner=':owner' -F repo=':repo' -F pr="$PR_NUMBER" \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)'
```

Human review threads follow the same table, except a human's question stays open until
the human resolves it.

## Escalation

When the PR cannot be made clean:

1. Stop pushing. Do not mark the PR ready, enable auto-merge, or retry the same fix.
2. Emit `BLOCKED` (`external`, `environment`, or `human`) with: PR and head SHA, each
   failing job with its log link, each round tried and what it changed, unaddressed bot
   threads, the hypothesis that remains, and the one action a human must take.
3. Raise it where the human will see it:
   - Interactive session (Claude Code, Cursor, Codex): the final message starts with
     `BLOCKED — PR #<n> still red after <k> fix rounds` (or the gate reason), followed by
     the details. Send a push notification when the harness offers one.
   - Unattended run: reach the human through the run's configured channel (issue or PR
     comment, Slack, text, email) with the same content.
   - Under an outer loop: return `BLOCKED`. The outer loop routes it to the human; it
     never swallows or downgrades it.
4. Never exit silently, and never report `PASS` or "done" for a PR that is red.
