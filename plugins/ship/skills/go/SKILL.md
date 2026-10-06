---
name: go
description: Full ship loop — merge master, fix conflicts, respond to reviews, fix tests, monitor CI
disable-model-invocation: true
---

# Go: Full Ship Loop

Automate the complete ship loop for the current branch: merge latest master and resolve conflicts, handle review comments, fix tests, and monitor CI until everything is green.

## Step 1: Merge Master and Resolve Conflicts

This is the FIRST thing to do — get the branch up to date with master before anything else.

1. Ensure working tree is clean:
   ```bash
   git status
   ```
   - If there are uncommitted changes, ask the user whether to stash or abort

2. Get the current branch and fetch latest:
   ```bash
   git branch --show-current
   git fetch origin
   ```

3. Also pull any new commits on the current branch from the remote:
   ```bash
   git pull --ff-only origin $(git branch --show-current) 2>/dev/null || true
   ```
   - `--ff-only` so it won't create merge commits or conflict with the master merge below
   - If it fails (diverged), that's fine — the master merge will handle things

4. Merge master into the current branch:
   ```bash
   git merge origin/master
   ```

5. Check for merge conflicts:
   ```bash
   git diff --name-only --diff-filter=U
   ```
   - If **no conflicts**: the merge completed cleanly, continue to Step 2

6. If there ARE conflicts, resolve them:
   - For each conflicted file:
     - Read the file and understand both sides of the conflict
     - Resolve by combining changes intelligently, preserving intent from both sides
     - Stage each resolved file: `git add <file>`
   - After ALL conflicts are resolved, complete the merge:
     ```bash
     git commit --no-edit
     ```

7. Run lint and compile checks to make sure the merge didn't break anything:
   ```bash
   git rev-parse --show-toplevel
   ```
   - Run linting (if available):
     ```bash
     cd <project-root> && bun lint 2>/dev/null || true
     ```
   - Run type checking (if available):
     ```bash
     cd <project-root> && bun compile 2>/dev/null || true
     ```
   - If either fails, fix the issues, re-run until passing, then commit the fixes

8. Push the merge:
   ```bash
   git push origin HEAD
   ```

Record for the final report: whether master was already up to date, merged cleanly, or had conflicts.

## Step 2: Respond to Reviews

1. Get the PR number:
   ```bash
   gh pr view --json number -q .number 2>/dev/null
   ```
   - If no PR exists, skip to Step 3

2. Fetch all review threads using GraphQL. **Capture the thread `id`** for each unresolved thread so you can resolve them later:
   ```bash
   gh api graphql -f query='
     query($owner: String!, $repo: String!, $pr: Int!) {
       repository(owner: $owner, name: $repo) {
         pullRequest(number: $pr) {
           reviewThreads(first: 100) {
             nodes {
               id
               isResolved
               comments(first: 50) {
                 nodes {
                   author { login }
                   body
                   path
                   line
                   createdAt
                 }
               }
             }
           }
         }
       }
     }' -F owner=':owner' -F repo=':repo' -F pr=<pr_number>
   ```

3. Filter to **unresolved threads only** (`isResolved: false`). Skip resolved threads entirely.

4. If there are no unresolved threads, skip to Step 3.

5. **Classify each thread as bot or human** based on the commenter(s):
   - **Bot**: login ends with `[bot]`, or is one of: `github-actions`, `dependabot`, `codecov`, `coderabbitai`, `sonarcloud`, `codeclimate`, `snyk-bot`, `renovate`, `semantic-release-bot`, `copilot`
   - **Human**: everything else

6. **Handle bot comments** (do this first, regardless of whether human comments exist):
   - Review each bot comment and decide whether to act on it
   - Auto-implement fixes where the suggestion is clearly correct (style, obvious bugs, security issues, etc.)
   - For anything skipped (ambiguous, out of scope, disagreed with): add to a **Flagged Items** list with brief reasoning — report this at the end
   - Do NOT pause for user approval on bot comments
   - After resolving bot threads, mark them as resolved:
     ```bash
     gh api graphql -f query='
       mutation($threadId: ID!) {
         resolveReviewThread(input: {threadId: $threadId}) {
           thread { isResolved }
         }
       }' -f threadId="<thread_id>"
     ```

7. **Handle human comments** (if any exist):
   - Present ALL unresolved human comments in a structured plan:
     ```
     ### 🔴 Must Fix (Blocking — CHANGES_REQUESTED)
     1. [file:line] @reviewer: "comment text"
        → Proposed fix: <description>

     ### ⚠️ Should Address (Suggestions)
     2. [file:line] @reviewer: "comment text"
        → Proposed fix: <description>

     ### 💬 Questions/Clarifications
     - Comment X: Need your input on approach

     ### 📝 Will Skip (N/A or out of scope)
     - Comment Z: Reasoning

     ### 💬 Suggested Replies
     For comments that warrant a reply, print the suggested text — never post replies automatically.
     ```
   - **Pause here and wait for the user to review and approve** before implementing any human comment fixes
   - After approval, implement the agreed fixes
   - Resolve addressed threads via GraphQL (same mutation as above)
   - Do NOT resolve threads the user decided to skip

8. If any changes were made (bot or human), commit and push:
   ```bash
   git add -A
   git commit -m "Address review comments"
   git push origin HEAD
   ```

## Step 3: Check Local Tests

1. Detect what test runner is available:
   - Check for `package.json` scripts (`test`, `check`), `Makefile` targets, `pytest.ini`, `go.mod`, etc.

2. If a test runner is found, run tests:
   ```bash
   # For JS/TS projects:
   bun test 2>/dev/null
   # Or:
   make test 2>/dev/null
   ```

3. If tests fail:
   - Read the failure output carefully
   - Fix the failing code or tests
   - Re-run to confirm passing
   - Commit and push the fix:
     ```bash
     git add -A
     git commit -m "Fix failing tests"
     git push origin HEAD
     ```

4. If no test runner is found, note that in the final report and continue.

## Step 4: Submit (handles CI monitoring)

Invoke the `/submit` skill. It commits any remaining changes, pushes, ensures a PR exists, and **spawns `/check-watcher` as a background sub-agent** to monitor CI.

Do **not** invoke `/check-watcher` directly — `/submit` already does it. After `/submit` returns, CI monitoring is running in the background; continue to the final report.

## Step 5: Final Report

Print a concise summary:

```
## Go Report

### Sync
- [Master already merged | Merged master cleanly | Merged master with N conflict(s) resolved | Also pulled N remote commits]

### Reviews
- [No PR found | No unresolved comments | Bot-only: fixed N items, flagged M | Human comments: paused for approval, implemented N fixes]

### Flagged Items (not fixed)
- file.ts:42 — CodeRabbit: "Consider using X" — skipped, not applicable to this codebase pattern
- (none if everything was addressed)

### Local Tests
- [No test runner found | All tests passing | Fixed N failures]

### CI
- [No PR | Monitored in background by /check-watcher sub-agent (spawned via /submit)]
```

## Rules

- Never use `--no-verify` or skip hooks
- Never force push unless explicitly asked
- Bot comments: auto-proceed, flag anything not addressed with reasoning
- Human comments: always pause and wait for explicit user approval before implementing
- If any step causes a push, the CI checks from that push must be monitored in Step 4
