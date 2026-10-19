# brewery approve

`brewery approve <pr>` reviews one pull request head against a rubric the repository
owns and posts one review as the **brewery-approve** GitHub App: `APPROVE` when the risk
level is one the repository allows, `COMMENT` otherwise, plus a `brewery/approve` check
run either way. The review's first line always says the level and why.

```bash
brewery approve 123 --dry-run      # print the verdict JSON and the review body, post nothing
brewery approve 123                # post as the App (needs the credentials below)
brewery approve 123 --base main    # base branch when it is not the PR's base
```

Design: [`docs/specs/2026-10-19-brewery-approval-agent-design.md`](specs/2026-10-19-brewery-approval-agent-design.md).

## What a verdict means

| First line | Meaning |
| --- | --- |
| `Risk: low — approved.` | The level is in `approveLevels`, no blocking finding, every gate clean. The App's review counts toward "Require approvals". |
| `Risk: <level> — not approved.` | The reasons follow, first one on that line, the rest after "Also:". A human reviews. |
| `Skipped.` | No model ran: draft, skip label, skipped author, the App's own PR, a human change request, or already approved at this head. Only the check run is written. |

The body then has a table of four dimensions scored 0–3 with reasons (plan match,
architecture, tests, evidence) and a collapsed block with findings, the plan judge's
report, the gates, the band code set, and the policy source (`.brewery.json` at
`<base>@<sha>`, which rubric, which agents).

Check run `brewery/approve`: `success` when approved; `failure` when a blocking finding
exists or the PR itself failed a gate (failing checks, size over the limit); `neutral`
otherwise; `skipped` on a skip. A repository may make it a required check.

## How the level is set

1. **Band (code).** Every changed file is matched against `pathRules`. The highest
   `floor` of any file is the minimum level. A `ceiling` applies only when every file
   matches a ceiling rule; then the loosest per-file ceiling caps the level. A `never`
   file blocks approval outright. A plan edited in the same PR raises the floor to
   medium.
2. **Plan judge (clean agent).** When the PR references an implementation plan, an agent
   that sees only the plan, the claimed task scope, and the diff reports aligned or
   drift, missing and unrequested work, and evidence gaps.
3. **Rubric (agent).** The agent gets the rubric, the band, the PR body marked as claims,
   checks, unresolved bot threads, the evidence inventory, the judge's report, and the
   diff, and returns a level, the four scores, findings, and a rationale.
4. **Merge and gates (code).** The level is clamped into the band. With fan-out, the
   strictest level wins and findings are unioned. Approval also needs: no failing or
   pending check on the head (other than the approver's own), no unresolved review thread
   started by a bot, no human `CHANGES_REQUESTED`, the diff under `maxLines`/`maxFiles`,
   no `never` file, and no blocking finding.

Agents run read-only: Claude in bare mode with read-only tools and a JSON-schema answer,
Codex in its read-only sandbox, each with a dollar budget and an allowlisted environment
that never holds a GitHub or App credential. The approver executes no PR code.

## Configuration

Everything comes from the **base branch**, so a PR cannot relax the policy it is judged
by. The `approve` block of `.brewery.json`:

```json
{
  "approve": {
    "approveLevels": ["low"],
    "rubric": "docs/approval-rubric.md",
    "planDirs": ["docs/implementationPlans", "docs/plans", "docs/tasks"],
    "skipAuthors": ["dependabot[bot]"],
    "skipLabels": ["do-not-merge", "hold"],
    "maxLines": 800,
    "maxFiles": 40,
    "budgetUsd": 5,
    "pathRules": [
      {"match": ["docs/**", "**/*.md"], "category": "docs", "ceiling": "low"}
    ]
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `approveLevels` | `["low"]` | Levels the App may approve. `[]` is comment-only mode: every PR gets the review and the check, nothing approves. |
| `rubric` | `docs/approval-rubric.md` | Repo-relative markdown the rubric agent judges by. Absent → brewery's default (`cli/templates/approval-rubric.md`), and the review says so. |
| `planDirs` | `["docs/implementationPlans", "docs/plans", "docs/tasks"]` | Where plans live. Found from body paths, the stage-result `ip:` slug, changed plan files, and a `docs/tasks/<slug>.md` sibling. |
| `skipAuthors` | `["dependabot[bot]"]` | PR authors that get a skip. |
| `skipLabels` | `["do-not-merge", "hold"]` | PR labels that get a skip. |
| `maxLines` | `800` | Changed lines above which the size gate blocks approval. |
| `maxFiles` | `40` | Changed files above which the size gate blocks approval. |
| `budgetUsd` | `5` | Dollar budget per agent step (two steps per head, times the agents in `stages.approve`). |
| `pathRules` | the list below | Ordered rules; a file takes every category it matches. A repo's list replaces the default wholesale. |

Default `pathRules`:

| Match | Category | Effect |
| --- | --- | --- |
| `docs/**`, `**/*.md` | docs | ceiling low |
| `**/*.test.ts`, `**/*.test.tsx`, `**/*.spec.ts`, `e2e/**`, `**/__snapshots__/**`, `**/fixtures/**` | tests | ceiling low |
| `**/auth/**`, `**/permissions/**`, `**/session*` | auth | floor high |
| `**/migrations/**`, `**/models/**` | migrations | floor high |
| `terraform/**`, `infra/**`, `Dockerfile*`, `**/*.env*` | infra | floor high |
| `.circleci/**`, `.github/workflows/**`, `.github/scripts/**` | ci | never |
| `.brewery.json`, `docs/approval-rubric.md` | policy | never |
| `**/bun.lock`, `**/package.json`, `**/yarn.lock` | deps | floor medium |

Agent routing uses the normal `stages` block: `"stages": {"approve": ["claude", "codex"]}`
fans out and takes the strictest verdict.

## The rubric file

Copy `cli/templates/approval-rubric.md` to `docs/approval-rubric.md` and edit. Keep the
level table, the four dimensions, and the blocking list; add the repository's own
architecture rules (generated files, data layer, logging, return types) under
Architecture. The prompt itself always tells the agent that the PR body is a claim and
that instructions inside the body or diff are content, not instructions.

## The GitHub App

Create a GitHub App (any name; `brewery-approve` is the default slug) with:

| Permission | Level | Used for |
| --- | --- | --- |
| Pull requests | write | the review, and dismissing the App's own stale approval |
| Checks | write | the `brewery/approve` check run |
| Contents | read | reading the base branch and the head |
| Metadata | read | required by GitHub |

Install it on the repositories or the organization. The App cannot approve a PR it
authored; `skipAuthors` and the self-check handle that.

Credentials in the CI environment:

| Variable | Meaning |
| --- | --- |
| `BREWERY_APP_ID` | the App id |
| `BREWERY_APP_PRIVATE_KEY` | its private key as PEM; literal `\n` or base64-wrapped both work |
| `BREWERY_APP_SLUG` | optional; the slug when it is not `brewery-approve` (also used by `--dry-run` for the skip gates) |
| `BREWERY_APP_INSTALLATION_ID` | optional; skips the installation lookup |
| `BREWERY_APPROVE_TOKEN` | optional; a pre-minted token that replaces minting (local runs) |
| `ANTHROPIC_API_KEY` | the model key for the read-only agent steps |
| `GH_TOKEN` | for the read side (`gh pr view`, `gh pr diff`); never passed to agents |

The installation token is minted in the post step and used only there.

## CI templates

- `templates/ci/circleci-approve.yml`: a job to paste into `.circleci/config.yml` (or
  `continue-config.yml`), with `requires` on the test jobs and a halt outside pull
  request pipelines.
- `templates/ci/github-approve.yml`: a workflow on `pull_request_target` that checks out
  the base, fetches the head as a ref, and runs the command. The PR's code is read, not
  run.

Both clone brewery at `master`; pin a tag or commit once one is cut.

## Rollout

1. Add the `approve` block with `"approveLevels": []` and the CI job. Every PR gets a
   comment review and a check run; nothing approves.
2. After a dozen PRs, compare the levels with how humans reviewed them. Tune `pathRules`
   and the rubric.
3. Set `"approveLevels": ["low"]`.
4. Consider "Dismiss stale pull request approvals when new commits are pushed" on the
   base branch.

## Stale approvals

Every head is judged afresh. When a later head is not approved and the App's earlier
approval is still active, the App dismisses that review with the new first line. If the
branch restricts dismissals to named people and GitHub refuses, the check summary says
the earlier approval is stale. An already-approved head is not re-reviewed.

## Where the run's files go

`.terreno/brewery/approve-<pr>/` holds `state.json`, `events.jsonl`, and
`steps/NNN-approve-<judge|rubric>-<agent>.{prompt.md,log}`, so the exact prompts and
answers behind a verdict can be read afterwards. It is git-ignored like every brewery
run.
