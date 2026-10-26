# Triage — from issues to a fix IP

How `tap` turns its input into a buildable, pre-approved IP. The rule behind every step:
build only what an issue reported, and only when the fix needs no human decision.

## Select

### Sources

Search every tracker the repository uses that this session can reach. Name any it uses
but you cannot reach in the report.

| Source | Resolve one | Search |
| --- | --- | --- |
| GitHub | `gh issue view <n> --json number,title,body,state,labels,assignees,createdAt,url,comments` | `gh issue list --state open --search "<terms> created:>=<iso>" --json number,title,createdAt,labels,assignees,url` |
| Linear | the Linear MCP tools, when connected | the same tools, filtered by team, label, and created date |
| Sentry | `GET /api/0/organizations/<org>/issues/?query=<short-id>` with `SENTRY_CLIENT_SECRET` (or `SENTRY_AUTH_TOKEN`) as the bearer token | the same endpoint with `query=is:unresolved <terms>` and `statsPeriod=24h` (or `start`/`end`) |

The current repository is the default GitHub repo. Repository instructions name the
Linear team and Sentry org and projects; when they do not, use only GitHub.

### Queries

- **Time.** "Recent", "last day", "today" become absolute ISO timestamps from the
  current time, recorded in the IP. Match on created time. Also include issues reopened
  or, for Sentry, first seen or regressed in the window.
- **Topic.** Tracker search is lexical. Search every spelling and synonym ("better auth",
  "better-auth", "betterauth", "auth session", "sign in", "login"), plus matching labels
  and the area's package or file names. Then read each candidate's title and body and
  keep it only if it is really about the topic. Record each candidate you dropped and
  why.
- **Size.** More than 12 matches means the query is too broad: in the chat, ask the human
  to narrow it; unattended, take the 12 newest and list the rest in the report.

### Skip

Leave out, with the reason recorded: closed issues, issues with an open PR that references
them (`gh pr list --state open --search "<n>"`, or the issue timeline), issues assigned to
someone else, and pull requests returned by the search.

## Triage

One fresh read-only subagent per issue, or per cluster of issues that obviously share a
cause. Brief it with the issue text, the files the issue or stack trace points at, and
the repository's test commands. It may read code, history, and docs, and run tests and
probes. It does not edit tracked files. It returns:

```text
Issue: <ref>
Disposition: fix | already-fixed | duplicate-of <ref> | cannot-reproduce | decide | upstream | needs-info
Symptom: <what the reporter sees, by shape, no PHI>
Reproduction: <the test or probe that shows it, and its output>
Root cause: <file:line and one sentence>
Fix: <the smallest change, one or two sentences>
Files: <files the fix and its test write>
Question: <decide only: the decision, 2-4 options, recommendation, and why>
Evidence: <commit, PR, log, or test output that supports the disposition>
```

### Dispositions

| Disposition | Test | Tap does |
| --- | --- | --- |
| `fix` | A reproduction shows the symptom, the expected behavior is stated in the issue, the docs, a test, or an obvious contract, and the fix needs no human decision | builds it |
| `already-fixed` | The symptom does not reproduce on the latest base, and a commit or merged PR explains why | reports the commit |
| `duplicate-of` | Same root cause as another selected issue | merges into that issue's fix; the PR closes both |
| `cannot-reproduce` | Two evidence-based attempts did not show the symptom | reports what was tried and what would help |
| `decide` | The fix needs a choice from the list below | asks once in the chat, otherwise reports the question |
| `upstream` | The cause is in a dependency or another repository | builds a small, test-backed workaround as `fix`, or reports where the fix belongs |
| `needs-info` | The issue does not say enough to know what is wrong or expected | reports the one fact needed |

An issue is `decide` when the fix would:

- change what users see or can do in a way the issue, docs, and tests do not settle
- change who can access what: permissions, roles, auth boundaries, data ownership
- touch PHI handling, retention, or logging of member data
- break or change a public API, schema, or wire format other code depends on
- need a destructive migration, a data backfill, or production data changes
- be a feature request or redesign whose behavior the issue does not settle

Restoring documented or tested behavior is a fix even in auth, permissions, or data code.
A crash, a wrong status code, a broken flow that used to work, or a mismatch with the docs
is a fix. When unsure, ask "would a reviewer who reads only the issue know what the fixed
behavior should be?" Yes is `fix`. No is `decide`.

Labels do not set the disposition. A `feature` or `enhancement` issue with a settled
proposal is `fix`: it names the API and the behavior, and none of the choices above stay
open. Only the open choices make it `decide`.

A Sentry error with a clear stack trace usually reproduces at the throwing seam: call
that function with an input of the failing shape. Fixing only the symptom (a `try`/`catch`
or a `?.` that hides the error) is not a fix unless the issue's expected behavior is
"ignore this case".

### Group

1. **Root causes.** Issues with the same root cause become one fix. Keep the earliest
   issue as primary; the rest are `duplicate-of` it.
2. **Areas.** Fixes that share a package, a seam, or the query's topic form one area,
   which becomes one IP, one branch, and one PR. Unrelated fixes become separate areas,
   so each PR has one reviewer story.
3. **Limits.** At most 6 fixes per area and 3 areas per run. Overflow goes in the report
   as the next batch, with the exact `tap` input to run it.

## The fix IP

One per area, at `docs/plans/YYYY-MM-DD-<slug>.md` unless the repository has its own
convention. The slug is `fix-<area>-<symptom>` (`fix-better-auth-session-refresh`), or
`fix-<n>-<symptom>` for one issue. It uses distill's task-line format, so `brewery barrel`
can parse and build it. Keep it short: the issues are the spec.

```markdown
# Fix <area>: <what is broken>

<Two or three sentences: what users hit, since when if known, and the shared root cause
when there is one.>

Selected: <the tap input, verbatim>, resolved <ISO timestamp> (window <start> to <end>)

## Issues

| Issue | Title | Disposition | Root cause | Task |
| --- | --- | --- | --- | --- |
| #12 | <title> | fix | <file:line, one line> | T1 |
| #15 | <title> | duplicate-of #12 | same as #12 | T1 |
| ENG-40 | <title> | decide | <one line> | none |

## E2E tests

None — <reason>, or:

| ID | Spec or flow | Layer | Proves | Written in |
| --- | --- | --- | --- | --- |
| E1 | <path the e2e guide prescribes> | <a layer from the guide> | <the fixed behavior> | T1 |

## Regression cases

None — <reason>, or:

Destination: <AREA> → <regression suites>/<area>.md

| ID | Case | Steps | Expected | Platforms | Automated by | Added |
| --- | --- | --- | --- | --- | --- | --- |
| <AREA>-new-1 | <the reported flow> | <starting state, then the reporter's action> | <the fixed behavior, observable> | <platforms> | <proof test>, or manual | <IP slug> |

## User guide

None — <reason>, or:

| ID | Page | Change | Audience | Written in |
| --- | --- | --- | --- | --- |
| G1 | <user guide page that described the broken behavior> | update | <audience> | T1 |

## Tasks

- [ ] **T1** — Fix <symptom> (#12, #15)
  - Depends on: none
  - Files: <files the fix and its test write>
  - Root cause: <file:line and one sentence>
  - Proof: `<test file>` "<test name>" fails on the base with <symptom> and passes on the branch
  - Closes: #12, #15

## Assumptions

<Implementation choices the fix relies on, or `None.`>

## Open questions (recommendation assumed)

<Questions a fix task relied on, in distill's table format, or `None.` Questions for
`decide` issues do not go here: those issues are not built.>

## Not fixed in this run

| Issue | Disposition | Next action |
| --- | --- | --- |

## Sign-off

Status: approved <date> (tap: <issue refs>)
```

Rules:

- `Depends on:` is `none` unless two fixes write the same file. Then order them.
- `## E2E tests` and `## Regression cases` follow
  [`testing plan`](../../terreno-shared/testing-plan.md) and are never missing. Most fixes
  are proved by the task's Proof test, so `## E2E tests` is usually
  `None — <reason>` (`None — proved by the unit test in T1`). Plan a spec only when the
  defect sits in a UI or cross-process flow the Proof test cannot reach.
  `## Regression cases` is usually `None — no hard-to-automate change`: add a row only
  when the broken flow is one a developer or QA must check by hand (push notifications,
  real email delivery, a cross-device flow) and no case covers it. When the suite
  already has a case for the flow, edit that row under its real ID instead.
- `## User guide` follows [`user guide`](../../terreno-shared/user-guide.md) and is never
  missing. It is usually `None — fix restores documented behavior`; add an `update` row
  when a guide page described the broken behavior or the fix changes what a user does.
  A repository whose `## User guide conventions` table says `none` writes
  `None — user guide off`.
- Every `fix` and `duplicate-of` issue maps to exactly one task. Every other issue appears
  in "Not fixed in this run".
- No Expansions section: tap builds nothing beyond the reported defects. A cleanup or
  follow-up idea found while triaging goes in the report.
- Never copy issue text that contains PHI, customer names, credentials, or tokens. Describe
  by shape.

## Closing issues

Put the closing references in the PR's `Why` section, one per fixed issue. The commit for
each task names its issues the same way.

| Source | Closes on merge |
| --- | --- |
| GitHub, same repo | `Fixes #12` |
| GitHub, other repo | `Fixes owner/repo#12` |
| Linear | `Fixes ENG-123` (with the Linear GitHub integration) |
| Sentry | `Fixes PROJECT-1A2` (with the Sentry GitHub integration; resolves in the next release) |

`duplicate-of` issues get their own closing line. Never use a closing keyword for an issue
the PR does not fix; reference it plainly instead (`Related: #20`).
