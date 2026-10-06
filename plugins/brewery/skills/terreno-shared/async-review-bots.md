# Async review bots

Brew and Taste **wait in-process** until async review bots on the current head have
reported, then continue the stage so they can react. Product test CI is a separate
Taste wait: follow [`product-ci.md`](product-ci.md) after this procedure, using GitHub
CLI or CircleCI CLI in a watch loop until jobs are terminal or that wait times out.

## What counts

A review bot is an automated GitHub actor that posts a check run, code-scanning alert,
or PR review/comment after a push. Match by check name, app slug, or review author.
Examples:

- Cursor Bugbot
- GitHub CodeQL / code scanning
- Copilot or other review bots when they appear on the PR

Do not treat ordinary product CI as a review bot. Product CI is lint, typecheck, unit,
e2e, and build work on **any** host (GitHub Actions, CircleCI, Buildkite, GitLab CI,
Jenkins, Azure Pipelines, Bitbucket Pipelines, and similar). Observe those jobs with
[`product-ci.md`](product-ci.md).

## When to wait

Wait after Brew has pushed or created the PR, and whenever Taste's current head has a
matched bot queued, in progress, or still inside the startup grace.

**Do not exit while a matched bot is queued or in progress.**

## Procedure

1. Record the current head SHA.
2. **Startup grace (90 seconds).** Use a provider-native hook only when it can await the
   **matched bot**, not arbitrary checks for this SHA. GitHub CLI has no targeted
   check-creation watch, so prefer the harness PR-event subscription. If no targeted
   hook can detect new checks, reviews, and comments, sleep 30 seconds and re-fetch.
   Stop the grace when a matched bot appears or 90 seconds elapse. If none appeared,
   continue.
3. **Completion wait.** Use a provider-native hook only when it targets the matched bot,
   not all PR checks. For a bot backed by a resolved GitHub Actions run, prefer
   `gh run watch <run-id> --interval 30`. Its exit code is a wait result, not a Brew
   verdict; always re-fetch and classify the bot outcome. Do **not** use unfiltered
   `gh pr checks --watch`: it also waits for ordinary product CI. For check-run-only or
   review/comment bots, prefer a harness PR-event subscription. If no targeted hook is
   available, sleep 30 seconds and re-fetch the matched bot state. Continue until every
   matched bot is terminal, or 20 minutes have elapsed.
   Terminal means the check completed (success, failure, cancelled, skipped, timed out)
   or the bot posted a completed review/comment batch for this head.
4. **Timeout.** If still running at 20 minutes, **stop**. Do not continue the stage
   procedure. Emit `PENDING` with `next: taste` and `wait: 120`. Record which bots are
   still running.
5. **Re-observe, then continue — only after a completed wait.** When every matched bot
   is terminal or none appeared after the grace period, use that snapshot. Brew records
   bot outcomes and does not implement fixes. Taste classifies bot findings and acts on
   actionable ones in this invocation.

Never hand-roll a sleep loop when the provider CLI or harness supplies a bounded
watch/subscription hook. If fallback polling is necessary, use the harness sleep
primitive and record why no hook applied. Do not busy-spin.

## Bounds

- This wait is only for review bots, never "until all CI is green."
- After Taste pushes a fix, wait again for review bots on the new head, then run the
  product-CI wait loop, then act on those results **once** in this invocation. A further
  push after that second act emits `PENDING` (`next: taste`); the outer loop owns later
  cycles.
- Product CI uses Taste's bounded watch loop (`gh` / `circleci`), not this review-bot
  procedure. Unfiltered `gh pr checks --watch` belongs there, not here.
