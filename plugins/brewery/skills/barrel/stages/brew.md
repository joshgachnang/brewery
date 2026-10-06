> Vendored from TerrenoLabs/terreno `plugins/terreno-claude/skills/4-brew/SKILL.md`
> (see `../../terreno-shared/VENDORED.md`). Driven by the `barrel` skill; not invoked on its own.


# Brew — submit

Move one verified implementation into review, wait for async review bots on that head,
emit current PR/head state, and exit. The outer loop invokes Taste separately. Brew
records bot outcomes but does not implement fixes.

Read the shared [`lifecycle contract`](../../terreno-shared/lifecycle-contract.md),
[`documentation contract`](../../terreno-shared/documentation-contract.md),
[`PR deployments`](../../terreno-shared/pr-deployments.md),
[`product CI`](../../terreno-shared/product-ci.md),
[`async review bots`](../../terreno-shared/async-review-bots.md),
[`independent review procedure`](../../terreno-shared/independent-review.md), and
[`subagent briefing`](../../terreno-shared/subagent-briefing.md). All GitHub text
must follow the [`GitHub attention contract`](../../terreno-shared/github-attention-contract.md).

## Preconditions

- Roast returned `PASS` for every in-scope task on the implementation being submitted.
- Branch/diff and verification evidence are available.
- No unresolved human gate remains.

## Inputs

- Approved IP/task and Roast result
- Current branch/head/diff and execution state
- Verification artifacts/evidence
- Repository instructions, available supporting skills, and PR template
- Existing PR title/body when updating (human edits are authoritative)

## Procedure

1. **Reconstruct.** Confirm the branch tree corresponds to the Roast-passed
   implementation. Behavioral changes after Roast return to Roast.
2. **Discover supporting skills.** Load applicable submission, documentation, commit,
   changelog, security, and repository verification skills.
3. **Run final gates.** Execute repository-required pre-submit checks. When the root
   `package.json` defines a `prepush` script, run it in a fresh subagent with no parent
   conversation before the first push. A red local gate is `FAIL`; do not push it. Confirm docs
   follow the documentation contract, generated files are current, changelog/release
   notes exist when required, and verification artifacts are complete. Ship without
   matching docs is `FAIL`.
4. **Review independently.** Review the branch on separate standards and IP/spec axes.
   Pass one task-scoped briefing (file list plus patch) to each reviewer; do not let
   each child rediscover the repo. Fix material findings outside Brew via Pick/Roast;
   do not smuggle implementation work into submission.
5. **Check hygiene.** Review status/diff; exclude loop-owned execution state, debug output,
   secrets, credentials, customer data, and unrelated files.
6. **Commit.** Follow repository commit and DCO/sign-off policy. Preserve the existing
   prohibition on AI attribution. Use behavior-scoped commits, one per roasted task,
   with no bookkeeping-only commits; do not rewrite pushed history unless explicitly
   allowed.
7. **Push.** Push once with upstream. Resolve only mechanical conflicts needed to update the PR,
   using repository conflict guidance and rerunning affected checks. A conflict requiring
   a design/behavior choice is `BLOCKED`.
8. **Create/update PR.** Apply the GitHub attention contract and any stricter repository
   template. On create, set the title to `[ticket] Short feature title` (Linear
   `TEAM-n` or GitHub `#n`; feature only, no `feat:` / `IP Approved` / `Task list`).
   Initialize `Why` from the IP's original justification and `What changed` from a
   brief overview of the approved IP and intended outcomes. Keep both stable unless
   scope or facts change. Always include reproducible testing instructions in
   `Verification`; update those instructions, evidence, and remaining risks as testing
   changes without rewriting the body around the latest turn. The visible body uses
   only `Why`, `What changed`, and `Verification`, stays under 250 words, and puts
   optional detail plus the stage-result YAML in one expandable Details block.
   Preserve human-edited title/body; make only accurate minimal edits. Attach only
   decisive UI/runtime artifacts without sensitive data.
9. **Do not announce.** Do not post a PR comment for creation, readiness, check results,
   or evidence already present in the body. A top-level comment is allowed only for one
   blocking human action that cannot live in an existing review thread.
10. **Confirm product CI, then wait for review bots.** Resolve the PR number/URL and
    pushed head SHA. Follow the product-CI procedure: discover every CI host on this
    branch (GitHub Actions, CircleCI, Buildkite, and similar) and confirm each triggered
    or documented a skip for this SHA on every discovered CI host. Then follow the
    async-review-bots procedure: prefer provider CLI watch hooks or harness event
    subscriptions; use bounded sleep/re-fetch only as a fallback. Wait until Bugbot,
    CodeQL, and similar review bots on this head are terminal, never appeared after the
    startup grace, or hit the 20-minute timeout. Do not exit while those bots are queued
    or in progress. Do not wait for ordinary product CI to finish.
11. **Record and exit.** Update execution state and emit:
    - review-bot timeout → `PENDING` with `next: taste` and `wait`
    - required host untriggered after grace → `FAIL` with `next: brew`
    - otherwise `PASS` with the PR/head, bot outcomes, and `next: taste`
    Collapse per the lifecycle contract. Close the chat with PR deployment URLs when
    the PR has them. Brew itself never executes Taste inline.
12. **Hand off.** Exit; `barrel` runs the `finish` skill (Taste until green). Do not
    end the session by telling the human to run Taste later.

## Supporting skills

Follow the shared discovery procedure. Project skills own exact lint/type/test commands,
documentation generation, changelog rules, commit/DCO policy, PR templates, conflict
handling, and mandatory evidence gates.

## Evidence produced

- Final checks and independent-review outcomes
- Commit and pushed head SHA
- PR URL/number and preserved template/body state
- Attached artifact references and sensitive-data check
- Discovered product-CI hosts and trigger/skip outcome per host
- Async review-bot names, statuses, and posted findings
- Updated execution state and structured Brew result

## Success conditions

- Verified implementation is committed/pushed and the PR accurately represents it.
- Product CI on every discovered CI host is triggered (or documented skipped) for the
  recorded current head.
- Async review bots on this head are terminal or did not appear after the startup grace.
- Emit `PASS` with `next: taste`, then exit.

## Failure conditions

Failed final checks, **Brew's own independent-review findings** (step 4), push errors,
PR setup errors, or a required CI host still untriggered after grace emit `FAIL` with
evidence and the smallest corrective stage/action:
behavioral defects use `next: pick`, stale/missing proof uses `next: roast`,
and submission-only retries use `next: brew`. Do not treat Bugbot, CodeQL, or similar
async review-bot findings as Brew `FAIL`; record them and emit `PASS` with
`next: taste`. Do not fix implementation inside Brew.

## Blocked conditions

Missing access, required human approval/decision, unsafe conflict, unavailable mandatory
submission capability, or sensitive-data risk emits `BLOCKED` with
`next: null` and the exact action required.

## Recommended next stage

- `PASS` → outer loop invokes a fresh Taste
- `PENDING` → outer loop waits, then invokes Taste
- `FAIL` → stage named by evidence (`pick`, `roast`, or `brew`)
- `BLOCKED` → outer loop routes the named gate

For standalone compatibility, a human/runner may invoke Taste immediately after Brew
returns. Brew itself never executes Taste and does not wait for product CI to finish.
