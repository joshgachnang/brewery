# Brewery approval agent — design

Status: approved direction
Date: 2026-10-19
Destination: `brewery approve <pr>` in this repo's `cli/`, plus CI job templates and a GitHub App identity

## Goals

1. Approve low-risk pull requests without a human, under a rubric the repo owner writes, so
   brewery-built and human-built PRs reach `master` on evidence rather than on who is online.
2. For PRs that implement an implementation plan (IP), make "does the code match the plan"
   the dominant signal, judged by an agent that sees only the plan and the diff.
3. Say why. Every verdict is a PR review whose body states the risk level, the score on each
   rubric dimension, and the reasons, whether or not it approves.
4. Run anywhere a CI job runs (CircleCI for terreno, GitHub Actions elsewhere) with no hosted
   service, and post as a dedicated GitHub App that repos or orgs install.
5. Never execute pull request code and never let a PR relax its own policy.

## What exists today (survey, 2026-10-18)

- **Flourish** (`FlourishHealth/flourish`, GitHub Actions on Blacksmith): Cursor's "PR Routing &
  Approval" automation approved 13 of the 51 PRs it reviewed in the last 60. Each verdict opens
  `Risk: low|medium|high.` and names the reasons, for example "Approved. Cursor Bugbot and Cursor
  Security Agent both completed successfully, Copilot has no open findings, and this PR is
  test-and-docs-only E2E coverage with no production code changes." It approves only `low`, only
  when the Bugbot and Security Agent checks succeeded and no bot thread is unresolved. Master
  requires one approval, has no required status checks, and does not dismiss stale reviews, so
  three PRs (#7162, #7197, #7203) merged on the bot's approval alone. Flourish is out of scope for
  this plan; it stays on Cursor's approver.
- **Terreno** (`TerrenoLabs/terreno`, CircleCI): no bot approves. Bugbot comments (High 9 / Medium
  27 / Low 15 over 60 PRs), and an in-house architectural review (`.github/scripts/architectural-pr-review.ts`,
  2.3k lines, Cursor CLI, run from `.circleci/continue-config.yml`, posts as `joshgachnang` via
  `GITHUB_TOKEN`) compares the diff against plans in `docs/implementationPlans/` and said
  "No comment" on 53 of 57 PRs. Master requires one approval, no required checks, squash only,
  bypass for `joshgachnang`.
- **Plans live in `docs/implementationPlans/`** in terreno and flourish, with task lists in
  `docs/tasks/`. Brewery-style repos use `docs/plans/`. Terreno PR bodies reference the plan
  inline (``IP: `docs/implementationPlans/<slug>.md`, Tasks 2.1–2.2``), as a markdown link, or
  as `ip: <slug>` inside the collapsed stage-result YAML. Only ~8 of 60 terreno PRs reference
  a plan at all.
- **What the bots find**, by volume across both repos: business-logic and state-machine bugs,
  races and stale state, web-vs-native divergence, docs not updated, missing tests, cross-origin
  PHI leakage and unauthenticated public endpoints, dependency compatibility on bumps,
  incomplete follow-through in sibling code (scaffold, SDK, OpenAPI), accessibility, CI script
  robustness. These are the model's job to catch; this design treats their presence as
  unresolved bot threads, a gate, not as something to re-find.
- **Brewery** already launches every step as a fresh `claude -p` or `codex exec` process
  (`cli/src/agents.ts`), routes stages through `stages` profiles with fan-out for `cut`,
  `roast`, `review`, snapshots PR checks and unanswered bot threads with `gh` (`cli/src/vcs.ts`),
  and reads `.brewery.json` per repo. The approver reuses all of it.

## Prior art

- **Greptile auto-approve**: approves only a clean review; risk ceiling with tiers Low (docs,
  tests, styling, small changes), Medium (ordinary app logic), High (dependency updates, build
  and runtime config, core shared modules), Critical (auth, secrets, billing, migrations,
  infra/CI, public APIs); policy read from the base branch; withheld on drafts, `do-not-merge`
  labels, and human change requests; new commits dismiss it.
- **Cursor's marketplace approval prompt**: never approve High; do not re-approve an already
  approved PR; re-evaluate on every push and revoke if risk rose, with a comment saying why; do
  not approve when a code-owner review is required.
- **GitHub Copilot approvals**: admins choose which paths Copilot may approve; the approval
  counts toward required approvals and is dismissed on new commits like a human's.
- **Qodo**: `estimated_effort_to_review` 1–5 and `auto_approve_for_low_review_effort`.
- **GitHub mechanics**: an App with *Pull requests: write* can `POST .../pulls/{n}/reviews` with
  `event: APPROVE`, and that approval satisfies "Require approvals". An App cannot approve a PR
  it authored. Dismissing its own approval needs *Pull requests: write* unless the branch
  restricts dismissals to named people. "Require review from Code Owners" is never satisfied by
  an App.

## Architecture

### Command

```text
brewery approve <pr> [--dry-run] [--repo owner/name] [--base <branch>]
```

One invocation reviews one head. It runs inside the repository's CI after the test jobs, so
check results for the head already exist. Exit 0 whether or not it approved; non-zero only when
it could not produce a verdict (no config, no token, agent failure).

### Flow

| Step | What | Owner |
| --- | --- | --- |
| 1 Resolve | PR number, head SHA, base branch, author, draft flag, labels, existing reviews by the App | `gh` via `Ci`/`Forge` |
| 2 Policy | Read `.brewery.json` `approve` block and the rubric file **from the base branch** (`git show origin/<base>:<path>`), never from the head | code |
| 3 Skip gates | Draft, skip label, skip author, App-authored PR, a human `CHANGES_REQUESTED`, already approved by the App at this head → write the check run and exit | code |
| 4 Classify | Changed files → categories (docs, tests, snapshots, generated, deps, auth, migrations, infra, ci, policy, source) → **ceiling** and **floor** levels from `pathRules` | code |
| 5 Context | Diff (`git diff base...head`), changed file list with stats, PR body split into `Why` / `What changed` / `Verification`, checks on the head, unresolved bot threads, plan text when found | code |
| 6 IP judge | Clean agent. Prompt holds only the plan, the task scope the PR claims, and the diff. Returns conformance JSON | agent (`stages.approve`) |
| 7 Rubric | Agent gets the rubric, the diff, the PR body, checks, evidence inventory, the IP judge's report, and the classification. Returns the verdict JSON. Read-only tools, turn budget | agent (`stages.approve`) |
| 8 Merge | `level = max(modelLevel, floor)` then `min(level, ceiling)`; fan-out takes the strictest level and the union of findings; `approve = level ∈ approveLevels ∧ no blocking finding ∧ gates` | code |
| 9 Post | Review `APPROVE` or `COMMENT` with the rendered body; check run `brewery/approve`; dismiss the App's prior approval when the new verdict is not approve | code, App token |

`--dry-run` stops after step 8 and prints the verdict JSON and the rendered body.

### Gates (code, not model)

Approval also requires, on the head SHA:

- no failing or cancelled check, and no pending check other than the approver's own;
- no unresolved review thread started by a bot (`unansweredBotThreads` already in `vcs.ts`);
- no human review in state `CHANGES_REQUESTED`;
- no file matched by a `never` rule (policy files, `.brewery.json`, the rubric, CI config by
  default);
- diff size under `maxLines` / `maxFiles` (defaults 800 / 40).

A gate failure never lowers the level; it only blocks approval and is named in the body.

### IP judge isolation

The judge sees the plan, the task scope, and the diff. It never sees the PR body's claims, the
rubric, or the first agent's opinion, the same way `cut` sees only the human's words. Scope is
the tasks the PR claims (body `Tasks 2.1–2.2`, stage-result `done:`), else every unchecked task.
Its report distinguishes:

| Field | Meaning |
| --- | --- |
| `status` | `aligned`, `drift`, `no_plan` |
| `missing[]` | claimed tasks or acceptance criteria the diff does not deliver |
| `unrequested[]` | behavior in the diff that no claimed task asks for |
| `planEdited` | the PR changes the plan it claims to implement (flag, never low) |
| `evidenceGaps[]` | acceptance criteria whose verification method is absent from the PR |

Plan discovery, in order: paths under `planDirs` referenced in the body; `ip:` in the
stage-result YAML → `<planDir>/<slug>.md`; changed files under `planDirs`; a `docs/tasks/<slug>.md`
sibling. `planDirs` defaults to `["docs/implementationPlans", "docs/plans", "docs/tasks"]`.

### Verdict JSON

```json
{
  "level": "low",
  "approve": true,
  "dimensions": {
    "ipMatch":      {"score": 3, "reasons": ["Tasks 2.1–2.2 delivered; no unrequested behavior"]},
    "architecture": {"score": 3, "reasons": ["Stays inside terraform/modules; no app/backend coupling"]},
    "tests":        {"score": 2, "reasons": ["Module tests cover IAM; no test for the empty-secret path"]},
    "evidence":     {"score": 3, "reasons": ["Verification table names commands and results; CI green"]}
  },
  "findings": [{"severity": "should-fix", "where": "terraform/modules/x/main.tf:40", "attack": "...", "evidence": "..."}],
  "rationale": "One-paragraph explanation in the reviewer's voice",
  "classification": {"categories": ["infra"], "floor": "high", "ceiling": null},
  "gates": {"checks": "pass", "botThreads": 0, "humanChangesRequested": false, "size": "ok"}
}
```

Scores are 0–3 per dimension (0 absent, 1 weak, 2 adequate, 3 strong). The level is the
model's call within the floor and ceiling; a `blocking` finding blocks approval at any level.
Fields outside the agent's authority (`classification`, `gates`, `approve`) are filled by code
after the agent returns and overwrite anything the agent wrote.

### Review body

```markdown
<!-- brewery-approve:<headSha> -->
**Risk: low — approved.** Test-and-docs-only change with a green CI run and a matching plan.

| Dimension | Score | Why |
| --- | --- | --- |
| Plan match | 3/3 | Tasks 2.1–2.2 delivered; nothing beyond the plan |
| Architecture | 3/3 | … |
| Tests | 2/3 | … |
| Evidence | 3/3 | … |

<details><summary>Findings (1) and gates</summary>

- **should-fix** `path:line` — …

Checks: 14 passed · Bot threads: 0 unresolved · Floor: none · Ceiling: low (docs and tests only)
Policy: `.brewery.json` at `master@<sha>`, rubric `docs/approval-rubric.md`

</details>
```

Not approved:

```markdown
**Risk: medium — not approved.** Clinical persistence on note completion is above the
configured approval level (`low`). Human review needed.
```

One review per head, found by the marker. No inline comments: Bugbot and the architectural
review already post inline, and the attention contract says a PR must be readable at a glance.

### Check run

`brewery/approve` on the head: `success` when approved, `neutral` when not approved without a
blocking finding, `failure` when a blocking finding exists or a gate fails because of the PR
(failing checks, size). Title `Risk: <level> — approved | not approved`, summary = rationale.
A repo can make it a required check; terreno should not until the dry-run period ends.

### Stale approvals

On every head the command re-evaluates. If the App has an active approval on the PR and the new
verdict is not approve, it dismisses that review with the new rationale. If the App already
approved this head, it exits without posting again. "Dismiss stale pull request approvals when
new commits are pushed" is recommended on `master` as belt and braces.

### Agents

`approve` joins `STAGES` and `FAN_OUT`. Default `stages.approve: ["claude"]`. A read-only launch
mode is added to `agents.ts`, selected per step:

| Agent | Read-only argv |
| --- | --- |
| claude | `claude -p --bare --permission-mode dontAsk --allowedTools Read,Grep,Glob,Bash(git diff:*),Bash(git show:*),Bash(git log:*) --disallowedTools Edit,Write,NotebookEdit --output-format json --json-schema <schema> --max-turns 40` |
| codex | `codex exec --json --sandbox read-only -C <cwd> -` |
| command | unchanged; the profile is trusted to be read-only |

The child environment is an allowlist (`PATH`, `HOME`, `TMPDIR`, `ANTHROPIC_API_KEY`, the
codex provider key) like flourish's `cursorAgentCli.ts`. The App token and `GH_TOKEN` are
never in the agent's environment. The schema comes from `--json-schema`; the result is also
validated in code (`readResult` plus a verdict validator), since the schema cannot enforce
score ranges.

Fan-out: every listed agent runs both steps; the merged level is the maximum, findings are
unioned by `where`, and approval requires every agent to approve.

### Configuration (`.brewery.json`, base branch)

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
    "pathRules": [
      {"match": ["docs/**", "**/*.md"],            "category": "docs",       "ceiling": "low"},
      {"match": ["**/*.test.ts", "e2e/**", "**/__snapshots__/**", "**/fixtures/**"], "category": "tests", "ceiling": "low"},
      {"match": ["**/auth/**", "**/permissions/**", "**/session*"], "category": "auth",      "floor": "high"},
      {"match": ["**/migrations/**", "**/models/**"], "category": "migrations", "floor": "high"},
      {"match": ["terraform/**", "infra/**", "Dockerfile*", "**/*.env*"], "category": "infra", "floor": "high"},
      {"match": [".circleci/**", ".github/workflows/**", ".github/scripts/**"], "category": "ci", "never": true},
      {"match": [".brewery.json", "docs/approval-rubric.md"], "category": "policy", "never": true},
      {"match": ["**/bun.lock", "**/package.json", "**/yarn.lock"], "category": "deps", "floor": "medium"}
    ]
  }
}
```

Rules are evaluated per file; a PR's ceiling is the **loosest** per-file ceiling, and only when **every**
file matches a ceiling rule (a docs-plus-source PR has no ceiling). The floor is the highest
floor of any matched file. `never` blocks approval. Brewery ships these defaults; a repo's
`pathRules` replaces the list. When the rubric file is absent, the shipped default rubric is
used and the review body says so.

### Default rubric (shipped as `cli/templates/approval-rubric.md`)

**Levels.**

| Level | Meaning | Examples |
| --- | --- | --- |
| low | A mistake is cheap and visible; the PR proves itself | docs; tests, snapshots, fixtures; copy and i18n strings; lint autofix; regenerated files whose source changed in the same PR; changelog fragments; dependabot patch bumps with green CI; one-line bug fixes with a regression test |
| medium | Ordinary product logic a reviewer would read once | new or changed behavior with tests; UI changes with screenshots; new endpoints with permission tests; minor dependency bumps; refactors inside one package |
| high | A mistake is costly, hidden, or hard to undo | auth, sessions, permissions; schema and migrations; data backfills; billing; PHI handling; secrets, env, infra, Dockerfiles; CI; public API shape; lockstep framework bumps; feature-flag removals; reverts of security changes; hotfix branches with commits not on master; deleted or skipped tests |

**Dimensions** (scored 0–3, each with reasons):

- *Plan match*: from the IP judge. No plan → score on whether the PR body's `Why` and `What
  changed` match the diff instead; code beyond what either asks for is drift.
- *Architecture*: layering and ownership per the repo's docs and skills; generated files not
  hand-edited; no duplication of an existing helper; follow-through in sibling layers (model →
  interface → OpenAPI → SDK; scaffold and templates); no new direct fetch where the repo has a
  data layer; logger not console; explicit return types where the repo requires them.
- *Tests*: new logic has tests that would fail without it; tests not deleted, skipped, or
  weakened; snapshot updates explained; coverage gate check green when present.
- *Evidence*: the `Verification` table names commands and outcomes, not just commands; UI
  changes carry screenshots or video; CI green on this head; `⚠️ Not tested` rows absent or
  covered by an explicit reviewer instruction; IP acceptance criteria each have their named
  verification present.

**Signals that move the level** (the model applies these; floors and ceilings are code):

- Raise one level: more than ~400 changed lines or ~20 files; more than two packages touched;
  deletions outnumber additions in source; a `TODO`/`FIXME` or commented-out code added;
  explicit `any` added; PR body missing `Why`, `What changed`, or `Verification`; title says
  WIP; the plan is edited in the same PR to match the code.
- Never low: new logic without a test; a `⚠️ Not tested` row; an unresolved bot thread; a
  revert; a bot-authored PR (Cursor cloud agents, Devin).
- Can stay low despite size: pure renames and moves verified by `git diff -M`; regenerated
  SDK or snapshots with the generating change in the same PR; dependency patch bumps.

**Blocking findings** (block approval at any level): a correctness bug the reviewer can point
to in the diff; PHI or secrets written to logs, errors, or third parties; a public endpoint
without a permission check; a migration without a rollback note; a test that asserts the bug.

### Security

- Inputs (diff, PR body, plan, bot threads) are untrusted. The IP judge never sees the body.
  The rubric agent is told the body is a claim, not evidence.
- Config and rubric come from the base branch. A PR touching them is `never` approved.
- The agent runs read-only with `--bare` (no hooks, MCP, or settings from the checkout), an
  allowlisted environment, and no GitHub token.
- The approver executes no PR code. Evidence is what CI and the author already produced.
- On GitHub Actions the job uses `pull_request_target` with the base checked out and the head
  fetched as a ref (`git fetch origin pull/<n>/head:pr-head`); the agent reads it through git.
  On CircleCI the job runs in the PR's own pipeline after the test jobs and reads
  `CIRCLE_PULL_REQUEST` for the number; secrets are CircleCI project env vars that the agent's
  environment allowlist excludes.
- The App needs *Pull requests: write*, *Checks: write*, *Contents: read*, *Metadata: read*.
  The CLI mints an installation token from `BREWERY_APP_ID` + `BREWERY_APP_PRIVATE_KEY`
  (+ optional `BREWERY_APP_INSTALLATION_ID`, else discovered by repo) and uses it only for the
  post step. `BREWERY_APPROVE_TOKEN` short-circuits minting for local dry runs.

### CI templates

`templates/ci/circleci-approve.yml` (a job to paste into `continue-config.yml`, `requires` the
test jobs, `filters` to PR pipelines) and `templates/ci/github-approve.yml` (a workflow on
`pull_request_target: [opened, synchronize, reopened, ready_for_review]` with
`concurrency` per PR). Both install bun, check out brewery at a pinned tag, run
`bun cli/src/cli.ts approve $PR`, and never fail the pipeline on a not-approved verdict.

## Rollout (terreno)

1. Josh creates the GitHub App (`brewery-approve`), installs it on `TerrenoLabs/terreno`, and
   adds `BREWERY_APP_ID`, `BREWERY_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY` to the CircleCI
   project.
2. Terreno PR: `.brewery.json` `approve` block with `approveLevels: []`, the job in
   `continue-config.yml`. Every PR gets a comment review and a check run; nothing approves.
3. After a dozen PRs, compare verdicts to human outcomes, tune `pathRules` and the rubric,
   then set `approveLevels: ["low"]`.
4. Consider enabling "dismiss stale approvals" on `master`.

## Out of scope

Running tests or any PR code; `REQUEST_CHANGES`; inline comments; reviewer assignment; a
hosted webhook service; Cursor CLI or Agent SDK backends; flourish rollout; replacing the
architectural review.

## Open risks

- Prompt injection through the diff or body can still talk the rubric agent down within the
  floor/ceiling band; the band, the gates, and the clean IP judge bound the damage, and the
  dry-run period measures it.
- Cost: two agent steps per head. A `maxTurns` and the read-only tool set bound it; fan-out
  doubles it and is off by default.
- GitHub may not let the App dismiss its own review on a branch that restricts dismissals to
  people; the body then says the approval is stale, and the check run turns `neutral`.
