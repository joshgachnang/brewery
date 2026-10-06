---
name: respond-to-review
description: Review PR comments, plan fixes, and implement — auto-submitting when no clarifications are needed
disable-model-invocation: true
---

# PR Review Response Workflow

Review comments on PR #$ARGUMENTS and plan fixes. If the plan has open questions for the user, pause for confirmation; otherwise implement, commit, and run `/submit` automatically without prompting.

## Step 1: Setup Working Directory

1. Check if we're already in a git worktree:
   ```bash
   git rev-parse --show-toplevel
   git worktree list
   ```

2. **If already in a worktree**, use the current directory — skip to Step 2.

3. **If NOT in a worktree**, set one up:

   a. Get the repo name:
      ```bash
      basename $(git rev-parse --show-toplevel)
      ```

   b. Fetch PR details and branch name:
      ```bash
      gh pr view $ARGUMENTS --json headRefName,number,title,url,author
      ```

   c. Fetch the PR branch:
      ```bash
      git fetch origin pull/$ARGUMENTS/head
      ```

   d. Create worktree at `~/.claude-worktrees/<repo-name>/pr-$ARGUMENTS`:
      ```bash
      git worktree add ~/.claude-worktrees/<repo-name>/pr-$ARGUMENTS FETCH_HEAD
      ```

   e. Change to the worktree directory:
      ```bash
      cd ~/.claude-worktrees/<repo-name>/pr-$ARGUMENTS
      ```

   f. Set up tracking for the PR branch:
      ```bash
      git checkout -B <branch-name> FETCH_HEAD
      git branch --set-upstream-to=origin/<branch-name>
      ```

**Important**: All subsequent work happens in the working directory (worktree or current).

## Step 2: Find the Reviews

1. Get review threads with resolution status using GraphQL. **Important**: capture the thread `id` for each unresolved thread so you can resolve them later.
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
           reviews(first: 50) {
             nodes {
               author { login }
               state
               body
             }
           }
         }
       }
     }' -F owner=':owner' -F repo=':repo' -F pr=$ARGUMENTS
   ```

2. **Ignore resolved threads entirely** — only process threads where `isResolved` is `false`

3. Filter to comments from other users (not the PR author)

4. Identify which remaining comments are:
   - Blocking (CHANGES_REQUESTED) vs suggestions
   - Inline code comments vs general comments

## Step 3: Decide What To Do & Propose a Plan

Decide the right action for each unresolved comment (fix, skip, ask), then present a structured plan organized by priority:

```
## PR #$ARGUMENTS Review Comments Plan

### 🔴 Must Fix (Blocking)
1. [file:line] @reviewer: "comment text"
   → Proposed fix: <description>

### ⚠️ Should Address (Suggestions)
2. [file:line] @reviewer: "comment text"
   → Proposed fix: <description>

### 💬 Questions/Clarifications Needed
- Comment X: Need your input on approach
- Comment Y: Conflicts with existing pattern, which to use?

### 📝 Will Skip (N/A or out of scope)
- Comment Z: Not applicable or out of scope

### 💬 Suggested Replies to Human Commenters
For any comments that warrant a reply (e.g., to clarify a decision or thank a reviewer):
- **Print the suggested reply text** so the user can see it
- **Never post replies** via `gh pr comment`, `gh api`, or any other method — leave posting to the user
```

## Step 4: Confirmation (only if there are open questions)

**If the plan has any items under 💬 Questions/Clarifications Needed:**
Ask: **"Need your input on the questions above. Anything else to change before I implement?"**
- Wait for explicit approval before making any changes
- Incorporate any feedback
- Re-present plan if significant changes requested

**If there are no open questions:** skip confirmation entirely. Proceed directly to Step 5 — implement, commit, run `/submit`, and resolve threads without further prompts. Do not ask the user for plan approval in this case.

## Step 5: Make the Fix

After approval:

1. Implement fixes one at a time, in priority order
2. After each fix, briefly confirm what was changed

## Step 6: Commit

1. Show the complete diff:
   ```bash
   git diff
   git diff --stat
   ```

2. Stage and commit the changes with a message describing what was addressed:
   ```bash
   git add -A
   git commit -m "<message>"
   ```

   Follow global commit rules (no conventional commit prefixes, no AI attribution).

## Step 7: Run /submit

Invoke the `/submit` skill to handle pre-commit checks, push, and PR updates. This will also launch the CI check-watcher in the background.

## Step 8: Resolve Addressed Threads

After `/submit` completes, resolve each review thread that was addressed in the implementation. Use the thread `id` captured in Step 2.

For each thread that was fixed or addressed (from the "Must Fix" and "Should Address" categories in the plan):
```bash
gh api graphql -f query='
  mutation($threadId: ID!) {
    resolveReviewThread(input: {threadId: $threadId}) {
      thread { isResolved }
    }
  }' -f threadId="<thread_id>"
```

Do NOT resolve threads that were:
- Skipped (marked as N/A or out of scope)
- Questions/clarifications that were not answered by code changes
- Threads where the user decided not to take action

Report which threads were resolved and which were left open.

---

## Error Handling

- If worktree already exists, ask if user wants to reset it or use existing
- If PR not found, show error and available PRs: `gh pr list`
- If no comments found, inform user and ask if they want to proceed anyway
- If merge conflicts occur during implementation, pause and ask for guidance

## Cleanup Reminder

If a new worktree was created, remind user:
```
To remove this worktree later:
  git worktree remove ~/.claude-worktrees/<repo>/pr-$ARGUMENTS

Or to keep working on it, you can open a new Claude session in:
  cd ~/.claude-worktrees/<repo>/pr-$ARGUMENTS
```
