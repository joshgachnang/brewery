# brewery approve

`brewery approve <pr>` reviews one pull request head against a rubric the repository
owns and posts one review as the **terreno-approval-agent** GitHub App: `APPROVE` when the risk
level is one the repository allows, `COMMENT` otherwise, plus a `terreno/approve` check
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

Check run `terreno/approve`: `success` when approved; `failure` when a blocking finding
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

### Running only after the rest of CI

`brewery approve <pr> --wait-checks [minutes]` polls the head until every check that is
not the approver's own has finished (default `limits.ciWaitMin`, 45 minutes), then runs.
In that mode a head whose checks failed, or are still pending at the deadline, is
**skipped** without spending a model: the review says `Skipped. checks failing on this
head: …` and the check run is `skipped`. The next push gets a fresh run. A head that moves
during the wait ends the run quietly; the push that moved it starts its own. A failing
check skips the head in every mode. Checks named in `selfChecks` (the `terreno/approve`
check run and the CI job the command runs in) never count as pending or failing, so a job
can judge the head it is part of.

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
| `selfChecks` | `["terreno/approve", "ci/circleci: approve", "approve"]` | Check names that belong to the approver (its check run, the CI job it runs in). Never pending, never failing, for the gates and for `--wait-checks`. |

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

## Learning the rubric from human reviews: `brewery calibrate`

```bash
brewery calibrate TerrenoLabs/terreno --dry-run             # print what humans said since the last pass
brewery calibrate TerrenoLabs/terreno                       # open one PR editing the rubric and path rules
brewery calibrate TerrenoLabs/terreno --reviewer joshgachnang --since 2026-09-01
brewery calibrate TerrenoLabs/terreno --notes review-notes.md   # add pasted comments or opinions
```

It reads every PR updated since the last pass (first pass: 30 days): human review
verdicts, inline comments with their diff hunks, conversation comments, and the approval
agent's own first line on the same PR when it reviewed it. Bot comments are dropped.
`--reviewer` keeps only the named logins; `--notes` adds a file of pasted review
comments or plain opinions, which count with the human's weight. The `calibrate` skill
then runs in a fresh worktree of the default branch and may edit only the rubric,
`.brewery.json`, and `docs/learnings/`: at most 8 new rubric lines, else no PR (exit 4).
brewery opens one PR per pass. Rules true of any repo come back as `proposals` in the PR
body and on stdout, as lines for `cli/templates/approval-rubric.md`.

Where the agent said low and a human requested changes, or the agent said high and a
human approved in silence, the skill treats the disagreement as the strongest evidence.
State lives beside cellar's in `~/.local/state/brewery/cellar/` (`calibrate__<owner>__<name>.json`,
`calibrate.log`). Run it on a timer like cellar, or by hand after a review session.

## The rubric file

Copy `cli/templates/approval-rubric.md` to `docs/approval-rubric.md` and edit. Keep the
level table, the four dimensions, the Security, Dependencies, Changelog and versioning,
and Plan expectations sections, and the blocking list; add the repository's own
architecture rules (generated files, data layer, logging, return types) under
Architecture, and the repository's names for the generic sections (its catalog, its
changelog form, its plan directories). The prompt itself always tells the agent that the PR body is a claim and
that instructions inside the body or diff are content, not instructions.

## The GitHub App

Create a GitHub App (any name; `terreno-approval-agent` is the default slug) with:

| Permission | Level | Used for |
| --- | --- | --- |
| Pull requests | write | the review, and dismissing the App's own stale approval |
| Checks | write | the `terreno/approve` check run |
| Contents | read | reading the base branch and the head |
| Metadata | read | required by GitHub |

Install it on the repositories or the organization. The App cannot approve a PR it
authored; `skipAuthors` and the self-check handle that.

Credentials in the CI environment:

| Variable | Meaning |
| --- | --- |
| `TERRENO_APP_ID` | the App id |
| `TERRENO_APP_PRIVATE_KEY` | its private key as PEM; literal `\n` or base64-wrapped both work |
| `TERRENO_APP_SLUG` | optional; the slug when it is not `terreno-approval-agent` (also used by `--dry-run` for the skip gates) |
| `TERRENO_APP_INSTALLATION_ID` | optional; skips the installation lookup |
| `TERRENO_APPROVE_TOKEN` | optional; a pre-minted token that replaces minting (local runs) |
| `ANTHROPIC_API_KEY` | the model key for the read-only agent steps |
| `GH_TOKEN` | for the read side (`gh pr view`, `gh pr diff`); never passed to agents |

The installation token is minted in the post step and used only there.

## CI templates

- `templates/ci/circleci-approve.yml`: a job to paste into `.circleci/config.yml` (or
  `continue-config.yml`), with `requires` on the test jobs and a halt outside pull
  request pipelines. After checkout it resets the working tree to the base branch, so
  nothing from the PR tree (a `bunfig.toml` preload, `.claude/` hooks, CI scripts) runs
  in the job that holds the App key; the head stays in the object store and brewery
  reads it with `git show <sha>:`.
- `templates/ci/github-approve.yml`: a workflow on `pull_request_target` that checks out
  the base, fetches the head as a ref, and runs the command. The PR's code is read, not
  run.

Both fetch brewery at `BREWERY_REF`, which takes a branch, tag, or commit sha. The job
holds the App key, so pin a commit and bump it deliberately.

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
