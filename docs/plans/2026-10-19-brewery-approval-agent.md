# Brewery approval agent

Status: approved 2026-10-19

`brewery approve <pr>` reviews one pull request head against a repo-owned rubric and posts one
review as a dedicated GitHub App: `APPROVE` when the risk level is in the repo's
`approveLevels`, otherwise `COMMENT`, plus a `brewery/approve` check run either way. Plan-backed
PRs are judged first by a clean agent that sees only the plan and the diff. Deterministic path
rules set floors and ceilings on the level before the model scores; gates (green checks, no
unresolved bot threads, no human change request, size, no policy edits) block approval in code.
Terreno is the first consumer, in comment-only mode until the verdicts have been compared with
human outcomes.

**Date:** 2026-10-19
**Design:** [brewery approval agent design](../specs/2026-10-19-brewery-approval-agent-design.md)

## Decisions

| ID | Question asked | Answer | What it changes |
| --- | --- | --- | --- |
| Q1 | Where should the approval agent live? | Inside brewery, as `brewery approve` in `cli/` | Reuses `agents.ts`, `config.ts`, `vcs.ts`, and the step/result shape; released with brewery |
| Q2 | How does it execute? | Own CLI inside each repo's CI; CircleCI job and GitHub Actions workflow templates shipped | No hosted service; auth is CI secrets; terreno keeps CircleCI |
| Q3 | What does it do when it will not approve? | `COMMENT` review with level and rationale, plus a check run | Never `REQUEST_CHANGES`; repos may require the check |
| Q4 | How does it roll out on flourish, which already has Cursor's approver? | Terreno only for now | No flourish wiring in this plan; Cursor's automation stays |
| Q5 | How should the approver run its model? | Brewery launcher with a new read-only mode | `approve` stage in `STAGES`/`FAN_OUT`; `--bare`, allowlisted tools, JSON schema; optional fan-out, strictest wins |
| Q6 | What may the approver itself execute? | Nothing; judge existing evidence | Evidence = checks on the head, PR `Verification` table, artifacts, tests in the diff |
| Q7 | How much rubric is code versus model? | Code floors and ceilings plus model scoring | `pathRules` in config; model moves only inside the band; blocking findings block at any level |
| Q8 | Where does per-repo config live? | `.brewery.json` `approve` block plus a rubric markdown, read from the base branch | Shipped default rubric when the file is absent; a PR editing policy is never approved |

Assumptions recorded without a question: one review per head, no inline comments; the App's own
stale approval is dismissed when a later head is not approved; drafts, skip labels, skip
authors, App-authored PRs, and PRs with a human `CHANGES_REQUESTED` are skipped; plan discovery
covers `docs/implementationPlans`, `docs/plans`, `docs/tasks`, body links, and the stage-result
`ip:` key; verdict and IP-judge schemas are enforced with `--json-schema` and re-validated in
code.

## Tasks

- [x] **T1** — Approve config and path classifier
  - Depends on: none
  - Files: `cli/src/config.ts`, `cli/src/approve/policy.ts`, `cli/test/approve-policy.test.ts`
  - Add `approve` to `Config` with the defaults from the design (`approveLevels`, `rubric`,
    `planDirs`, `skipAuthors`, `skipLabels`, `maxLines`, `maxFiles`, `pathRules`), merged like
    the other blocks; a repo's `pathRules` replaces the default list.
  - `classify(files, rules)` → `{categories, floor, ceiling, never[]}`: floor is the highest
    floor of any matched file; ceiling applies only when every file matches a ceiling rule;
    `never` lists the files that block approval. Glob matching with `Bun.Glob`.
  - `mergeLevel(model, floor, ceiling)` and `decide(level, config, gates, findings)`.
  - Add `approve` to `STAGES` and `FAN_OUT` with default `stages.approve: ["claude"]`.
  - Verify: unit tests for docs-only → ceiling low; docs+source → no ceiling; auth file → floor
    high; `.brewery.json` in diff → never; model `low` with floor `medium` → `medium`; a
    blocking finding at `low` → not approved; `brewery agents` lists `approve`.

- [x] **T2** — Read-only agent launch mode
  - Depends on: none
  - Files: `cli/src/agents.ts`, `cli/src/step.ts`, `cli/test/unit.test.ts`
  - `RunRequest.readOnly?: {schema: object}`: claude argv becomes `claude -p --bare
    --permission-mode dontAsk --allowedTools Read,Grep,Glob,Bash(git diff:*),Bash(git show:*),Bash(git log:*)
    --disallowedTools Edit,Write,NotebookEdit --output-format json --json-schema <schema>
    --max-turns 40`; codex adds `--sandbox read-only` and drops the bypass flag; `command`
    passes through.
  - Read-only steps get an allowlisted child environment (`PATH`, `HOME`, `TMPDIR`, `USER`,
    `SHELL`, `ANTHROPIC_API_KEY`, the codex provider's `envKey`, `BREWERY_PROMPT_FILE`,
    `BREWERY_RESULT_FILE`) and never `GH_TOKEN`, `GITHUB_TOKEN`, or `BREWERY_APP_*`.
  - Claude's `--output-format json` puts the structured result in `structured_output`; `readResult`
    accepts that envelope when the result file is absent, so the agent need not write a file.
  - Verify: `agentArgv` snapshot tests for both modes; an env test proving a `GH_TOKEN` in the
    parent is absent from the child; the scripted fake agent in `cli/test/helpers.ts` gains a
    read-only fixture that emits a structured result.

- [x] **T3** — PR context and plan discovery
  - Depends on: none
  - Files: `cli/src/approve/context.ts`, `cli/src/vcs.ts`, `cli/test/approve-context.test.ts`,
    `cli/test/fixtures/approve/`
  - `Ci` gains `prView(cwd, pr)` → `{number, headSha, base, author, isDraft, labels, body,
    title, reviews[{author, state, id, isApp}], checks, botThreads}` and `prFiles(cwd, pr)` →
    `[{path, additions, deletions, status}]`; implemented with `gh pr view --json` and
    `gh pr diff`/`gh api`, faked in tests like the existing `Ci`.
  - `splitBody(body)` → `{why, whatChanged, verification, stageResult}`; `verification` parses
    the table into rows `{status: tested|instructions|notTested, scope, evidence}`.
  - `findPlans(ctx)` in the design's order: body paths under `planDirs`, stage-result `ip:` →
    `<planDir>/<slug>.md`, changed files under `planDirs`, `docs/tasks/<slug>.md`; reads each
    from the **head** for judging and notes `planEdited` when the file is in the diff; reads
    the policy and rubric from the **base** (`git show origin/<base>:<path>`).
  - `claimedScope(body)` → task ids from `Tasks 2.1–2.2`, `T3, T4`, or stage-result `done:`.
  - Verify: fixtures of three real terreno PR bodies (inline IP reference, markdown link,
    Details block with YAML) each resolve the same plan path; a body with no plan → `[]`;
    a verification table with a `⚠️` row parses to `notTested`.

- [ ] **T4** — IP judge step
  - Depends on: T2, T3
  - Files: `cli/src/approve/judge.ts`, `cli/src/prompts.ts`, `cli/src/approve/schemas.ts`,
    `cli/test/approve-judge.test.ts`
  - Prompt contains only the plan text, the claimed scope, and the diff; it instructs the agent
    to report `status`, `missing[]`, `unrequested[]`, `planEdited`, `evidenceGaps[]`, and
    `summary`, and to cite task ids and file paths. No PR body, no rubric.
  - Runs through `runStage(ctx, "approve", …)` with `readOnly` and the judge schema; when no
    plan is found the step is skipped and the report is `{status: "no_plan"}`.
  - Fan-out: reports are kept per agent; `missing` and `unrequested` are unioned.
  - Verify: a flow test with the fake agent proves the prompt file contains the plan and diff
    and not the body text (assert on a sentinel string in the body); schema validation rejects
    an unknown `status`.

- [ ] **T5** — Rubric step, verdict merge, default rubric
  - Depends on: T1, T4
  - Files: `cli/src/approve/review.ts`, `cli/src/prompts.ts`, `cli/src/approve/schemas.ts`,
    `cli/templates/approval-rubric.md`, `cli/test/approve-review.test.ts`
  - Prompt = rubric markdown (repo's or shipped default), classification with floor/ceiling,
    diff, changed files with stats, PR body sections marked as claims, checks, unresolved bot
    threads, evidence inventory (verification rows, image/video links, tests in the diff), and
    the IP judge report. Asks for the verdict JSON from the design (level, four dimensions with
    scores 0–3 and reasons, findings with severity/where/attack/evidence, rationale).
  - Code overwrites `classification`, `gates`, and `approve`; applies `mergeLevel`; fan-out
    takes the maximum level, unions findings by `where`, and approves only if every agent's
    level is approvable.
  - Default rubric is the design's "Default rubric" section verbatim, with the level table, the
    four dimensions, the raise/never/can-stay-low signals, and blocking findings.
  - Verify: unit tests for merge (model low + floor high → high; ceiling low + model medium →
    low; fan-out low+medium → medium; blocking finding → `approve: false`); a flow test with
    two fake agents proves strictest-wins; an invalid score (4) is rejected before merge.

- [ ] **T6** — `brewery approve` command and review rendering
  - Depends on: T5
  - Files: `cli/src/commands/approve.ts`, `cli/src/cli.ts`, `cli/src/approve/render.ts`,
    `cli/test/approve-flow.test.ts`
  - `brewery approve <pr> [--dry-run] [--repo owner/name] [--base branch]`: resolve → policy
    from base → skip gates → classify → context → judge → rubric → merge → render. State and
    step files live in `.terreno/brewery/approve-<pr>/` so prompts and results are inspectable;
    events go to the run's `events.jsonl`.
  - `render(verdict)` produces the body from the design: marker `<!-- brewery-approve:<sha> -->`,
    bold first line `Risk: <level> — approved|not approved.` plus one sentence, the dimension
    table, and a collapsed findings-and-gates block naming the policy source.
  - `--dry-run` prints the verdict JSON and the body and exits 0 without GitHub writes.
  - Skips (draft, label, author, App-authored, human changes requested, already approved at
    this head) exit 0 with a one-line reason and still write the check run when not dry-run.
  - Verify: end-to-end flow test with fake `Ci` and fake agents for an approve verdict, a
    not-approve verdict, and a skip; snapshot of the rendered body; `--dry-run` performs no
    write calls on the fake.

- [ ] **T7** — GitHub posting as the App
  - Depends on: T6
  - Files: `cli/src/approve/github.ts`, `cli/src/approve/token.ts`, `cli/test/approve-github.test.ts`
  - `installationToken()`: `BREWERY_APPROVE_TOKEN` if set; else sign a JWT (RS256, `node:crypto`)
    from `BREWERY_APP_ID` + `BREWERY_APP_PRIVATE_KEY`, resolve the installation for the repo
    (`GET /repos/{owner}/{repo}/installation`) unless `BREWERY_APP_INSTALLATION_ID` is set, and
    `POST /app/installations/{id}/access_tokens`. Token is used only in this module.
  - `postReview`: find the App's review with this head's marker → no-op; else
    `POST /pulls/{n}/reviews` with `event: APPROVE|COMMENT` and the body. When the verdict is not
    approve and the App has an active `APPROVED` review on an older head, `PUT …/dismissals`
    with the new first line; on 403 record "could not dismiss" in the check-run summary.
  - `postCheck`: `POST /repos/{owner}/{repo}/check-runs` name `brewery/approve`, head SHA,
    conclusion per the design, title and summary from the verdict.
  - Verify: unit tests with a fake fetch for token minting (JWT claims `iss`, `iat`, `exp`),
    idempotence on an existing marker, dismissal path, and the 403 fallback; a live `--dry-run`
    against a real terreno PR with `BREWERY_APPROVE_TOKEN` prints a verdict (recorded in the
    PR evidence, not a test).

- [ ] **T8** — CI templates and docs
  - Depends on: T6
  - Files: `templates/ci/circleci-approve.yml`, `templates/ci/github-approve.yml`, `cli/README.md`,
    `README.md`, `docs/approve.md`
  - CircleCI job: runs after test jobs (`requires`), only when `CIRCLE_PULL_REQUEST` is set,
    installs bun, checks out brewery at a pinned tag, runs `bun cli/src/cli.ts approve <n>`,
    `continue-on-error` equivalent so a not-approve never reddens the pipeline.
  - GitHub Actions workflow: `pull_request_target` (opened, synchronize, reopened,
    ready_for_review), base checkout, `git fetch origin pull/<n>/head:pr-head`, concurrency per
    PR, `permissions: contents: read` only (the App token does the writes).
  - `docs/approve.md` (how-to + reference): what the verdict means, the config block with every
    field, the default `pathRules`, the rubric file, the App's permissions, the CI secrets,
    the dry-run rollout, and the stale-approval behavior. README sections point to it.
  - Verify: both templates pass `bun test` YAML-parse checks; `docs/approve.md` documents
    every key in `DEFAULT_CONFIG.approve` (a test greps the doc for each key).

- [ ] **T9** — Terreno dry-run wiring (gated on the GitHub App)
  - Depends on: T7, T8
  - Files: in `TerrenoLabs/terreno`: `.brewery.json`, `.circleci/continue-config.yml`,
    `docs/approval-rubric.md`
  - Human gate: Josh creates the `brewery-approve` GitHub App (Pull requests: write, Checks:
    write, Contents: read, Metadata: read), installs it on `TerrenoLabs/terreno`, and adds
    `BREWERY_APP_ID`, `BREWERY_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY` to the CircleCI project.
  - Terreno PR adds the `approve` block with `approveLevels: []`, a rubric file seeded from the
    default plus terreno's reviewer rules (`.cursor/agents/terreno-reviewer.md`: APIError,
    findExactlyOne, logger, testIDs, Luxon, generated SDK only), and the CircleCI job.
  - Verify: on the wiring PR itself the job posts a `COMMENT` review and a `neutral` check run
    (policy file in diff → never approve); on the next unrelated low-risk PR the review body
    shows `Risk: low — not approved` with "approveLevels is empty" as the reason.

## Out of scope

Running tests or PR code; `REQUEST_CHANGES`; inline comments; reviewer assignment; hosted
webhook service; Cursor CLI or Agent SDK backends; flourish rollout; replacing the
architectural review; enabling `approveLevels: ["low"]` on terreno (a later one-line PR after
the dry-run period).

## Open risks

- Prompt injection inside the floor/ceiling band; measured during the dry-run period.
- Two agent steps per head; bounded by `--max-turns` and read-only tools.
- The App may be unable to dismiss its own review where dismissals are restricted to people.
