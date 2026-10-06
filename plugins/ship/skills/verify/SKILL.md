---
name: verify
description: "Verify Implementation — find the relevant IP, compare implementation to the plan, flag drift, fix code or plan"
disable-model-invocation: true
---

# Verify Implementation Against Plan

Find the implementation plan that matches the current work, diff what was actually built against what the plan said, and reconcile any drift — by either fixing the code or fixing the plan.

## Argument

Optional IP number, filename, slug, or path. If empty, infer from context.

Parse the argument: `$ARGUMENTS`

## Phase 1: Locate the IP

Find the implementation plan that this work belongs to. Try these in order until one yields a clear match:

1. **Explicit argument** — if the user passed an IP number/slug/path, resolve it under `docs/implementationPlans/`.
2. **Branch name** — `git rev-parse --abbrev-ref HEAD`. Look for an IP slug or number embedded in the branch.
3. **Recent commits** — `git log --oneline -20`. Look for `IP-XXX` prefixes or feature names matching a plan file.
4. **Changed files** — `git diff --name-only` against the merge base. Grep `docs/implementationPlans/` for any plan that lists those files in its "Files to Create/Modify" section.
5. **Conversation context** — most recently discussed IP in this session.

If still ambiguous, list the candidates and ask the user which one. If no IP exists at all, say so and stop — there is nothing to verify against.

Read the matched plan file in full, plus any companion task file under `docs/tasks/`.

## Phase 2: Inventory the Implementation

Figure out what was actually built on this branch.

1. Determine the base commit: `git merge-base HEAD origin/master` (or the project's main branch).
2. `git diff --stat <base>...HEAD` — list of files touched and rough size.
3. `git log <base>..HEAD --oneline` — commit history for narrative context.
4. Read every non-trivial changed file (or the relevant hunks of large files). Don't skim — you need enough detail to compare against the plan's intent.

If there are also uncommitted changes (`git status`), include those in the inventory and note them as "uncommitted" in the report.

## Phase 3: Compare Against the Plan

Walk the plan section by section and check each claim against the actual code. For each, decide: **Matches**, **Partial**, **Missing**, or **Extra (not in plan)**.

Check at minimum:

- **Models** — every model/field/migration the plan lists. Are they present? Types/constraints/indexes match?
- **APIs** — every endpoint. Method, path, request/response shape, auth, validation.
- **UI / Screens** — every screen and component the plan called out. Routing wired up? testIDs present where the plan or `CLAUDE.md` requires them?
- **Notifications / Activity log / Feature flags / Migrations** — anything the plan promised that lives outside the main feature code.
- **Phases & Tasks** — for each task in the task file, is it actually done? Mark task-level drift specifically.
- **Acceptance Criteria** — sanity-check each criterion against the code (don't run tests yet, just read).
- **Extras** — code changes on this branch that the plan doesn't mention at all. These are just as important as missing items.

For verification, prefer Read/Grep over assumptions. Cite file paths and line numbers in your findings.

## Phase 4: Report Drift

Present a structured drift report:

```
## Verification: {plan title}

**Plan:** docs/implementationPlans/{file}
**Branch:** {branch}  ·  **Base:** {base sha}
**Files changed:** {n}  ·  **Commits:** {n}

### Matches
- {item} — {one-line evidence with file:line}

### Partial
- {item} — what's there vs what the plan said, with file:line

### Missing
- {item} — plan section that called for it

### Extra (not in plan)
- {item} — file:line, brief description

### Task Status Drift
- Task X.Y marked done but {evidence it isn't}
- Task X.Z not marked but appears complete
```

Keep it tight — one line per item where possible.

## Phase 5: Reconcile (requires user input)

For every Partial / Missing / Extra item, the resolution is one of:

- **Fix the code** — implementation should match the plan; do the work.
- **Fix the plan** — the implementation is right and the plan is stale; update the IP file (and task file if affected).
- **Accept the drift** — note it explicitly in the plan's "Not included / Future work" or "Changes during implementation" section.
- **Defer** — leave it, track it elsewhere.

Present the items grouped by suggested resolution (your recommendation per item) and ask the user to confirm or override before making any changes. Do **not** start editing code or the plan until the user has decided.

After the user decides, execute the agreed actions:
- Code fixes: edit, then commit with a descriptive message (infer `IP-XXX:` prefix from branch/commits if applicable).
- Plan fixes: edit the IP file in place; also update the task file if task statuses changed. Commit separately.

## Phase 6: Final Summary

End with a one-paragraph summary: how much of the plan landed, what changed in the plan vs the code, and whether the IP is ready to move to `pending verification` / `complete` (suggest running `/ip:close` if so).
