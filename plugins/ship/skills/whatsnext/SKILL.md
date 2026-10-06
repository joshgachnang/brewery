---
name: whatsnext
description: Triage all open PRs — respond to reviews, merge approved PRs, monitor failing checks
disable-model-invocation: true
---

# Whatsnext Triage

Handle all open PRs that need attention in one session.

## Step 1: Scan PRs

Run `whatsnext` to show the user what needs attention:
```bash
whatsnext
```

## Step 2: Get Structured Data

Get structured PR data to act on programmatically:

```bash
ME=$(gh api user --jq '.login')
```

Get all open PRs:
```bash
gh search prs --author="$ME" --state=open --limit=200 --json repository,number,title,url,headRefName
```

For each PR, determine its category using `gh api` calls:

1. **Ready to merge**: Has approval, no unresolved threads (regardless of check status — approval + LGTM comments = ready)
2. **Merge conflicts**: Has merge conflicts with the base branch (check `mergeable` field via `gh pr view <number> -R <repo> --json mergeable`)
3. **Failing checks**: Has failing CI runs (whatsnext already re-requested them)
4. **Needs response**: Has unresolved threads or substantive comments needing a reply (NOT just approvals/LGTM)
5. **Drafts without reviewers**: Draft PRs with no reviewers requested — may need a look or reviewers added

Use parallel agents/tasks to gather this data efficiently.

## Step 3: Present Triage Plan

Present a clear plan grouped by category:

```
## Triage Plan

### Ready to Merge
1. repo#123 "Title" - Approved by user1
2. repo#124 "Title" - Approved by user2 (checks pending)

### Merge Conflicts
3. repo#333 "Title" - conflicts with main

### Failing Checks
4. repo#456 "Title" - test-unit, lint

### Needs Response
3. repo#789 "Title" - 3 comments from user2

### Drafts Without Reviewers
4. repo#101 "Title" - Draft, no reviewers requested
```

Ask the user for each category:
- **Ready to merge**: "Which of these should I merge? (all / list numbers / none)"
- **Merge conflicts**: "Which should I resolve? I'll set up a worktree, rebase/merge, and push. (all / list numbers / none)"
- **Failing checks**: "I'll run check-watcher on these to fix failures automatically. Any to skip?"
- **Needs response**: "Which should I address? (all / list numbers / none)"
- **Drafts without reviewers**: "Any of these ready for review? I can mark them ready and/or request reviewers."

Wait for explicit decisions before proceeding.

## Step 4: Execute

Use `TaskCreate` to fire off **one task per PR action**, all in parallel. Each task runs independently. The main agent polls task status and collects results for the final report.

### Merge tasks

For each PR the user approved for merge, create a task:
```
TaskCreate: "Merge repo#N"
→ gh pr merge <number> -R <repo> --squash
```

### Conflict resolution tasks

For each PR with merge conflicts the user wants to resolve, create a task. Each task independently:

1. **Set up worktree** using the same worktree setup as review response tasks below.
2. **Check for uncommitted changes** — if present, stop and report.
3. **Fetch and rebase** onto the base branch:
   ```bash
   git -C $WT_DIR fetch origin
   git -C $WT_DIR rebase origin/$(gh pr view <number> -R <repo> --json baseRefName --jq '.baseRefName')
   ```
4. **Resolve conflicts** — read conflicted files, understand both sides, resolve sensibly. Run tests if available.
5. **Continue rebase and push**:
   ```bash
   git -C $WT_DIR add -A
   git -C $WT_DIR rebase --continue
   git -C $WT_DIR push --force-with-lease origin $BRANCH
   ```
6. **Report back**: which files had conflicts, how they were resolved.

### Check-watcher tasks

For each PR with failing checks, create a task that runs `/check-watcher` in a worktree. Each task:

1. Set up a worktree for the PR branch (same worktree setup as review response tasks below)
2. Run the check-watcher workflow from within the worktree:
   - Poll check status every 60 seconds via `gh pr checks <number> -R <repo>`
   - If checks are still running, wait and re-check
   - If checks fail, read the failure logs with `gh run view <run-id> --log-failed`
   - Analyze failures and fix the code, then delegate verification to the `pre-commit` subagent (Agent tool, `subagent_type: pre-commit`) before committing and pushing
   - Loop until checks pass or max 5 attempts
3. Report back: checks passing, still failing (with names), or stuck after max attempts

### Review response tasks

For each PR the user wants to address, create a task. Each task independently:

1. **Set up worktree** (non-interactively, always use existing branch):

   a. Get repo info:
      ```bash
      REPO_NAME=$(basename $(git rev-parse --show-toplevel))
      BRANCH=<headRefName from the PR>
      WT_DIR="$HOME/.claude-worktrees/$REPO_NAME/$BRANCH"
      ```

   b. Prune stale worktree entries:
      ```bash
      git worktree prune
      ```

   c. If worktree already exists at `$WT_DIR`, use it as-is.

   d. If branch exists locally or on remote, create worktree using existing branch:
      ```bash
      git fetch origin $BRANCH
      mkdir -p $(dirname $WT_DIR)
      git worktree add $WT_DIR $BRANCH 2>/dev/null || git worktree add $WT_DIR origin/$BRANCH
      ```

   e. If the branch doesn't exist (shouldn't happen for open PRs):
      ```bash
      git fetch origin pull/<number>/head
      git worktree add -b $BRANCH $WT_DIR FETCH_HEAD
      ```

   f. **Check for uncommitted changes**:
      ```bash
      git -C $WT_DIR status --porcelain
      ```
      If there are uncommitted changes, **STOP processing this PR**. Report:
      "PR repo#N has uncommitted changes in worktree. Skipping — needs manual attention."

2. **Gather review comments** using the same GraphQL query as respond-to-review:
   ```bash
   gh api graphql -f query='
     query($owner: String!, $repo: String!, $pr: Int!) {
       repository(owner: $owner, name: $repo) {
         pullRequest(number: $pr) {
           reviewThreads(first: 100) {
             nodes {
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
           reviews(first: 50) {
             nodes {
               author { login }
               state
               body
             }
           }
         }
       }
     }' -F owner="$OWNER" -F repo="$REPO_NAME" -F pr=$NUMBER
   ```

3. **Only process unresolved threads** where `isResolved` is `false`. Filter out resolved threads entirely.

4. **Analyze and implement fixes** in the worktree:
   - Categorize: blocking (CHANGES_REQUESTED), suggestions, questions, skippable
   - Make changes one at a time
   - Run tests if available

5. **Commit and push**:
   ```bash
   git -C $WT_DIR add -A
   git -C $WT_DIR commit -m "<message>"
   git -C $WT_DIR push origin $BRANCH
   ```
   - Do not use prefix commit format (feat:, fix:, chore:, etc.)
   - Do not mention AI, Claude, or any AI assistant
   - Do not add "Co-Authored-By" trailers

6. **Report back** what was done: files changed, comments addressed, questions flagged.

### Draft PR tasks

For each draft PR the user wants to act on, create a task:
```
TaskCreate: "Handle draft repo#N"
→ gh pr ready <number> -R <repo>          (if marking ready)
→ gh pr edit <number> -R <repo> --add-reviewer <reviewer>  (if requesting reviewers)
```

## Step 5: Live Status Board

After firing all tasks, render a live status board. Poll tasks with `TaskGet` and re-render every cycle.

Use this exact format (rendered as a code block so it displays as a monospace grid):

```
╭──────────────────────────────────────────────────────────╮
│  whatsnext                                    3/7 done   │
├──────────────────────────────────────────────────────────┤
│  ✅  Merge    terreno#42  "Add auth"                     │
│  ✅  Merge    amoeba#15   "Fix typo"                     │
│  🔄  Review   terreno#38  "Better forms"   fixing...     │
│  🔄  Monitor  amoeba#12   "New cache"      waiting (2m)  │
│  ✅  Draft    terreno#50  "WIP endpoint"   marked ready  │
│  🔄  Review   terreno#44  "New API"        reading...    │
│  ⏳  Review   amoeba#18   "Refactor"       queued        │
╰──────────────────────────────────────────────────────────╯
```

Status icons:
- `⏳` — queued (task created, not started yet)
- `🔄` — in progress
- `✅` — completed successfully
- `❌` — failed or errored
- `⏭️` — skipped

Column layout: `icon  action  repo#N  "title"  status detail`

Right-align the done count in the header (`3/7 done`). Update the board on each poll cycle. When a task completes, update its icon and status detail. When a review task needs user input, show `awaiting approval` as the status detail.

## Step 6: Final Report

Once all tasks finish, print a summary report:

```
## Triage Report

### Merged
- repo#123 "Title" — squash merged

### Conflicts Resolved
- repo#333 "Title" — rebased onto main, resolved 2 files
- repo#334 "Title" — failed to resolve (complex conflicts in src/auth.ts)

### Check Fixes
- repo#456 "Title" — checks passing (fixed lint error in 2 attempts)
- repo#457 "Title" — stuck after 5 attempts: test-unit

### Review Responses
- repo#789 "Title" — 3 comments addressed, pushed
- repo#790 "Title" — skipped (uncommitted changes)

### Drafts
- repo#101 "Title" — marked ready, requested reviewer1
- repo#102 "Title" — no action taken

### Decisions
- Merged N PRs
- Resolved conflicts on N PRs (M succeeded, K failed)
- Responded to N reviews
- N checks fixed (M now passing, K stuck)
- N drafts flagged (M acted on)
- Skipped: repo#790 (uncommitted changes)
```

## Important Rules

- Always wait for user decisions before taking action (Step 3)
- Review response tasks should present their fix plan and wait for user approval before implementing
- Never force-push or use --no-verify
- If a worktree has uncommitted changes, stop and report — do not discard them
- When setting up worktrees, always choose to use the existing branch (never delete/recreate)
- Set tmux window title when entering a worktree: `tmux rename-window "REPO|BRANCH"` (if in tmux)
- Fire all tasks at once — merges, check monitors, review responses, and draft actions all run in parallel
- Cap review response tasks at 5 concurrent to avoid GitHub API rate limits
