---
name: fullsend
description: Smart ship pipeline — adapts to context. Handles pre-commit, review, commit, PR creation, CI monitoring, and review comments in one command.
disable-model-invocation: true
model: sonnet
---

# Fullsend: Smart Ship Pipeline

Ships your changes intelligently. Adapts based on what's needed — skips unnecessary work, never duplicates effort.

## Step 1: Assess Context

Gather all context in parallel using Bash:

```bash
git status && git diff --stat
```

```bash
git fetch origin master && git log --oneline origin/master..HEAD
```

```bash
gh pr view --json number,title,url -q '"\(.number) \(.title) \(.url)"' 2>/dev/null || echo "no-pr"
```

```bash
git diff --stat master...HEAD 2>/dev/null || git diff --stat HEAD~1
```

From this, determine:

- **HAS_PR**: whether a PR already exists
- **FILES_CHANGED**: number of files changed vs master
- **LINES_CHANGED**: total insertions + deletions vs master
- **BEHIND_MASTER**: whether the branch is behind origin/master
- **IS_SMALL_UPDATE**: HAS_PR AND FILES_CHANGED < 5 AND LINES_CHANGED < 100

## Step 2: Merge Master (if behind)

Only if BEHIND_MASTER:

```bash
git merge origin/master
```

If there are conflicts:
- Read each conflicted file, resolve intelligently preserving intent from both sides
- Stage resolved files: `git add <file>`
- Complete merge: `git commit --no-edit`

If merge was clean or no merge needed, continue.

## Step 3: Code Review (skip if IS_SMALL_UPDATE)

Only for new PRs or significant changes. Read every changed file and check against:
- Project rules from CLAUDE.md (testID conventions, selector strategy, async patterns, etc.)
- General quality: duplicated logic, unclear naming, hardcoded values, missing error handling at system boundaries, security issues

Check for an implementation plan:
```bash
git branch --show-current
ls ~/.claude/plans/ 2>/dev/null
```
If a plan or FD file matches this branch, compare implementation against it.

Print a brief findings report:
```
### Code Review
- **Standards:** [N issues | all clear]
- **Plan compliance:** [compliant | N deviations | no plan]
- **Quality:** [N issues | all clear]
```

Fix all issues found before continuing.

## Step 4: Pre-Commit Checks

Delegate lint, type check, and related tests to the `pre-commit` subagent. This happens exactly once.

Use the `Agent` tool:
- `subagent_type`: `pre-commit`
- `description`: `Run pre-commit checks`
- `prompt`: instruct it to run lint, compile, and related tests for the current project, fix any issues, and report back. Mention that this is being run as part of `/fullsend` for an upcoming commit.

Wait for the subagent to return its Pre-Commit Report before continuing. If it stops with unfixable failures, surface the failure to the user and STOP — do not proceed to commit/push.

## Step 5: Submit (Commit, Push, PR, CI Watch)

Invoke the `/submit` skill to handle commit, push, PR creation/update, and to spawn `/check-watcher` as a background sub-agent for CI monitoring. Pass `$ARGUMENTS` through as the description.

`/submit` already:
- Creates the commit with the right message style
- Pushes
- Creates the PR (or skips if one exists)
- Spawns `/check-watcher` as a background sub-agent — **do not start check-watcher yourself**

After `/submit` returns, CI is being monitored in the background. Continue to the final report — the sub-agent will handle bot review comments and any CI fixes autonomously, and will notify when done.

## Step 6: Final Report

```
## Ship Report
- **Sync:** [up to date | merged master cleanly | resolved N conflicts]
- **Review:** [skipped (small update) | N issues fixed | all clear]
- **Pre-commit:** [all passed | fixed N issues]
- **PR:** **<title>** — <url>
- **CI:** monitored in background by /check-watcher sub-agent
```

## Rules

- Use Sonnet for all subagent work — never Opus
- Never use `--no-verify` or skip hooks
- Never force push unless explicitly asked
- No AI attribution in commits or PRs
- No conventional commit prefixes
- Bot review comments: auto-fix if clearly correct, flag otherwise
- Human review comments: STOP and notify the user
- Run unattended — do not pause for approval except for human review comments

## Arguments

$ARGUMENTS: Optional description to guide the commit message and PR
