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
[`push ownership`](../../terreno-shared/push-ownership.md),
[`independent review procedure`](../../terreno-shared/independent-review.md),
[`testing plan`](../../terreno-shared/testing-plan.md),
[`user guide`](../../terreno-shared/user-guide.md), and
[`subagent briefing`](../../terreno-shared/subagent-briefing.md). All GitHub text
must follow the [`GitHub attention contract`](../../terreno-shared/github-attention-contract.md).

## Preconditions

- Roast returned `PASS` for every in-scope task on the implementation being submitted.
- Branch/diff and verification evidence are available.
- No unresolved human gate remains.

## Inputs

- Approved IP/task and Roast result, including the IP's `## E2E tests`,
  `## Regression cases`, and `## User guide` sections and Roast's per-row results
- Current branch/head/diff and execution state
- Verification artifacts/evidence
- Repository instructions, available supporting skills, and PR template
- Existing PR title/body when updating (human edits are authoritative)

## Procedure

1. **Reconstruct.** Confirm the branch tree corresponds to the Roast-passed
   implementation. Behavioral changes after Roast return to Roast.
2. **Discover supporting skills.** Load applicable submission, documentation, commit,
   changelog, security, and repository verification skills.
3. **Run final gates.** Resolve the e2e guide and `Regression suites` directory per the
   testing plan, and the `User guide` path per the user guide, then gate the IP's
   testing-plan and user-guide sections before the other checks.
   An IP that lacks a section follows that contract's legacy rule: warn once and skip
   that section's gate.
   - **Planned specs.** Confirm every `## E2E tests` row has a spec at its path that
     passed: Roast recorded it `PASS` on the tree being submitted, or Brew reruns its
     command green now. Only Brew accepts a `deferred` row, and only when its recorded
     command passed locally in this invocation or in a terminal product-CI run on this
     branch. A deferred row no local runner can reach, whose command a product-CI job
     on a discovered host runs, does not block the push; step 10 settles it. A missing
     spec, a failing row, or a red run of a deferred row's command is `FAIL` with
     `next: pick` that names the row ID. A deferred row whose command neither a local
     runner nor any CI job on a discovered host runs is `BLOCKED` naming the row and
     its command.
   - **Regression cases.** Merge every `## Regression cases` row into
     `<Regression suites>/<area>.md`, finding each file by the `Area:` line its
     `Destination:` prefix names. Create a missing file from the testing-plan suite
     format. Give each provisional `<AREA>-new-<n>` row the next free ID, set `Added`
     to the IP slug, and replace an `E<n>` in `Automated by` with that row's spec path.
     A row with a real ID edits that case in place and keeps its ID and `Added`. Leave
     the IP tables unchanged; record each provisional-to-real ID mapping in execution
     state and the Brew result. On a rerun, find rows already merged from this IP by
     that mapping or, failing that, as rows this branch added to the suite file (diff
     against the merge base) whose `Added` is the IP slug, and update them instead of
     adding duplicates.
   - **User guide.** Unless the repository opts out, confirm every `## User guide` row
     has its page at the row's path in the user-guide page format (or, for `retire`,
     that the page and its index entry are gone), that the guide index lists exactly
     the pages on disk, and that each changed page sets `added` or `updated` to the IP
     slug. A missing page or index mismatch is `FAIL` with `next: pick` that names the
     row ID. An IP that lacks the section follows the user-guide legacy rule.

   Then check the branch and the PR body you will write against
   [`approval-ready`](../references/approval-ready.md), the approval agent's plan-match,
   architecture, tests, and evidence bars: a code gap is `FAIL` with `next: pick`, a body
   gap is fixed in step 8. Then execute repository-required pre-submit checks, so suite
   checks see the merged rows. When the root
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
   allowed. Suite rows merged in step 3 are a deliverable, not bookkeeping: commit
   them in one commit per Brew invocation that changes them, named for the cases.
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
   changes without rewriting the body around the latest turn. List every regression
   case ID the PR adds or changes in one `Verification` row that links its suite file,
   under `⚠️ Not tested` unless a person walked every listed case on this branch. The
   visible body uses
   only `Why`, `What changed`, and `Verification`, stays under 250 words, and puts
   optional detail plus the stage-result YAML in one expandable Details block.
   The Details block opens with a short `Provenance` section, one line each: the
   agents and models that ran cut, the reviews, the tests-first writer, and approval
   (the plan's sign-off: the human, or `pour` approving itself), then any agent that was
   rerouted, escalated, or fell back. Record only what the run's state or logs show and
   write `unknown` for the rest. Never guess a model. The PR approval agent records its
   own agents in its verdict.
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
    or in progress. Do not wait for ordinary product CI to finish. The one exception
    is a deferred `## E2E tests` row step 3 left for CI: wait for the job that runs
    its command to finish on this head. Green accepts the row; red is `FAIL` with
    `next: pick` naming the row ID.
11. **Record and exit.** Update execution state and emit:
    - review-bot timeout → `PENDING` with `next: taste` and `wait`
    - required host untriggered after grace → `FAIL` with `next: brew`
    - otherwise `PASS` with the PR/head, bot outcomes, and `next: taste`
    Collapse per the lifecycle contract. Close the chat with PR deployment URLs when
    the PR has them. Brew itself never executes Taste inline.
12. **Hand off.** Exit; `barrel` runs the `finish` skill (Taste until green). Do not
    end the session by telling the human to run Taste later. A pushed PR is never left
    unwatched: if `finish` cannot run, escalate per
    [`push ownership`](../../terreno-shared/push-ownership.md#escalation).

## Supporting skills

Follow the shared discovery procedure. Project skills own exact lint/type/test commands,
documentation generation, changelog rules, commit/DCO policy, PR templates, conflict
handling, and mandatory evidence gates.

## Evidence produced

- Final checks and independent-review outcomes
- Each `## E2E tests` row with its spec path and the passing run Brew accepted
- Each regression case written to the suite, with its provisional and real ID and
  suite file
- Each `## User guide` row with its page path and change
- Commit and pushed head SHA
- PR URL/number and preserved template/body state
- Attached artifact references and sensitive-data check
- Discovered product-CI hosts and trigger/skip outcome per host
- Async review-bot names, statuses, and posted findings
- Updated execution state and structured Brew result

## Success conditions

- Verified implementation is committed/pushed and the PR accurately represents it.
- Every `## E2E tests` row has a spec at its path with a passing run on this branch.
- Every `## Regression cases` row is in its suite file under a real ID, and the PR
  `Verification` section lists those IDs.
- Every `## User guide` row's page is written, updated, or retired, and the guide index
  matches the pages on disk.
- Product CI on every discovered CI host is triggered (or documented skipped) for the
  recorded current head.
- Async review bots on this head are terminal or did not appear after the startup grace.
- Emit `PASS` with `next: taste`, then exit.

## Failure conditions

Failed final checks, a missing or failing `## E2E tests` row, including a red CI run of
a deferred row (`next: pick`, naming the row ID), a missing `## User guide` page,
**Brew's own independent-review findings** (step 4), push errors,
PR setup errors, or a required CI host still untriggered after grace emit `FAIL` with
evidence and the smallest corrective stage/action:
behavioral defects use `next: pick`, stale/missing proof uses `next: roast`,
and submission-only retries use `next: brew`. Do not treat Bugbot, CodeQL, or similar
async review-bot findings as Brew `FAIL`; record them and emit `PASS` with
`next: taste`. Do not fix implementation inside Brew.

## Blocked conditions

Missing access, required human approval/decision, unsafe conflict, unavailable mandatory
submission capability, a deferred `## E2E tests` row nothing can run, or sensitive-data
risk emits `BLOCKED` with
`next: null` and the exact action required.

## Recommended next stage

- `PASS` → outer loop invokes a fresh Taste
- `PENDING` → outer loop waits, then invokes Taste
- `FAIL` → stage named by evidence (`pick`, `roast`, or `brew`)
- `BLOCKED` → outer loop routes the named gate

For standalone compatibility, a human/runner may invoke Taste immediately after Brew
returns. Brew itself never executes Taste and does not wait for product CI to finish, except
for the CI job that settles a deferred `## E2E tests` row.
