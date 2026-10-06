---
name: submit
description: Lightweight pre-commit + commit + push + create/update PR, then spawn check-watcher in the background. Use /fullsend for the full pipeline with code review.
model: sonnet
---

# Submit: Quick Commit & PR

Lightweight path to run pre-commit checks, commit, push, and monitor CI. After pushing, this skill launches `/check-watcher` as a background sub-agent so CI is watched without blocking. Use `/fullsend` for the full pipeline that also includes code review.

## Step 1: Assess Changes

```bash
git status && git diff --stat
```

```bash
gh pr view --json number -q .number 2>/dev/null || echo "no-pr"
```

## Step 1.5: Pre-Commit Checks

Delegate lint, type check, and related tests to the `pre-commit` subagent before committing.

Use the `Agent` tool:
- `subagent_type`: `pre-commit`
- `description`: `Run pre-commit checks`
- `prompt`: instruct it to run lint, compile, and related tests for the current project, fix any issues, and report back. Mention this is being run as part of `/submit` for an upcoming commit.

Wait for the subagent to return its Pre-Commit Report. If it surfaces unfixable failures, STOP and report them — do not commit or push.

If invoked from `/fullsend` (which already ran pre-commit), skip this step.

## Step 2: Commit

Stage and commit:
- Review the diff to write an accurate message
- Keep first line under 72 characters
- No conventional commit prefixes
- No AI attribution

## Step 3: Push

```bash
git push origin HEAD
```

## Step 4: Create or Update PR

### If no PR exists

```bash
gh pr create --title "<title>" --body "$(cat <<'EOF'
## Summary
[What changed and why — 2-4 sentences]

## Human Testing Steps
- [ ] [Step-by-step verification instructions]

## Changes
- [Bullet list of specific changes]

## Automated Tests
- [Tests that ran and passed, or "None"]
EOF
)" --draft
```

### If a PR already exists

Read the current title and body, then compare against the full set of commits on the branch:

```bash
gh pr view --json title,body,baseRefName
git log $(gh pr view --json baseRefName -q .baseRefName)..HEAD --oneline
git diff $(gh pr view --json baseRefName -q .baseRefName)...HEAD --stat
```

Decide whether the description still reflects what's on the branch — pay attention to commits added since the PR was opened:
- **Summary** still matches the actual goal of the changes
- **Changes** list covers the new commits, not just the original ones
- **Human Testing Steps** still cover what reviewers need to verify
- **Automated Tests** section reflects current test state

If the description is stale or incomplete, update it. Preserve sections the user has clearly edited by hand — only rewrite what's actually out of date, and merge new bullets into existing lists rather than replacing them wholesale:

```bash
gh pr edit --title "<title>" --body "$(cat <<'EOF'
<updated body>
EOF
)"
```

If the description is already accurate, skip the edit and note that it's up to date.

## Step 5: Print PR Link

```bash
gh pr view --json title,url -q '"**\(.title)** — \(.url)"'
```

## Step 6: Launch Check Watcher Sub-Agent

Spawn `/check-watcher` as a **background sub-agent** so CI monitoring runs autonomously without blocking the parent conversation. Use the `Agent` tool with `run_in_background: true`.

- `subagent_type`: `general-purpose`
- `description`: `Watch CI for current PR`
- `run_in_background`: `true`
- `prompt`: instruct the sub-agent to invoke the `/check-watcher` skill for the current PR, fix any failures, and report back when checks are green or max attempts are hit. Include the PR number/URL from Step 5 so the sub-agent has context.

Do **not** wait on the sub-agent — return control immediately after spawning. The user will be notified when it completes.

If no PR exists (Step 1 returned `no-pr`), skip this step.

## Arguments

$DESCRIPTION: Optional description to guide the commit message and PR
