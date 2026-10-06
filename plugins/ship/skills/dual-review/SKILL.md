---
name: dual-review
description: Dual-model code review using Claude and Codex CLI with combined todo list
disable-model-invocation: true
---

# Dual Review

Run parallel code reviews using a Claude sub-agent and the OpenAI Codex CLI, then combine
findings into a single prioritized todo list and optionally fix selected items.

## Arguments

$ARGUMENTS: Optional. Pass `--deep` for an in-depth Opus-powered Claude review (default: Sonnet).

## Step 1: Gather Context

First, detect the default branch and find the merge-base (where this branch forked):

```bash
# Detect default branch
git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "master"
```

```bash
# Find the merge-base (the commit where this branch diverged from the default branch)
MERGE_BASE=$(git merge-base HEAD <default-branch>)
echo "Merge base: $MERGE_BASE"
```

Use the merge-base commit for all diffs going forward. This ensures you only review changes
made on this branch, not upstream changes to the default branch.

```bash
git diff $MERGE_BASE...HEAD --stat
git log $MERGE_BASE..HEAD --oneline
```

If there are no commits ahead of the merge-base (e.g. you're on the default branch),
fall back to reviewing uncommitted/staged changes:

```bash
git diff --stat
```

If there's nothing to review, tell the user and stop.

Store the merge-base commit hash — you'll pass it to both reviewers so they diff against the
correct base.

## Step 2: Run Both Reviews in Parallel

Launch both reviewers at the same time. Do NOT wait for one before starting the other.

### 2a: Claude Sub-Agent

Use the **Task tool** with `subagent_type: "code-reviewer"`:

- If `$ARGUMENTS` contains `--deep`, set `model: "opus"`. Otherwise use `model: "sonnet"`.
- Pass the merge-base commit hash into the prompt so it diffs against the correct base.
- Prompt the sub-agent with:

> You are reviewing code in the current repository. Run `git diff <MERGE_BASE>...HEAD` to see only
> the changes made on this branch (not upstream changes). The merge-base commit is: <MERGE_BASE>.
>
> Review for: bugs, security vulnerabilities, correctness issues, error handling gaps, race conditions,
> and performance problems.
>
> Return your findings as a numbered markdown list. For each finding include:
> - **Severity**: `critical`, `warning`, or `info`
> - **File and line**: e.g. `src/api.ts:42`
> - **Description**: What the issue is and why it matters
> - **Suggested fix**: A brief description of how to fix it
>
> If there are no issues, say "No issues found."

### 2b: Codex CLI

Use the **Bash tool** to run Codex. Write the output to a temp file so it's captured reliably:

```bash
codex exec --full-auto -o /tmp/codex-review-output.txt "Run git diff <MERGE_BASE>...HEAD to see the code changes on this branch. The merge-base commit is <MERGE_BASE>. Only review changes from this branch, not upstream. Focus on: code style, architecture, maintainability, naming conventions, duplication, and design patterns. Return a numbered markdown list of findings. For each finding include severity (critical/warning/info), file path and line number, description of the issue, and a suggested fix. If there are no issues, say No issues found."
```

Replace `<MERGE_BASE>` with the actual commit hash from Step 1.

Then read the output:

```bash
cat /tmp/codex-review-output.txt
```

**Important**: Launch both 2a and 2b at the same time using parallel tool calls.

## Step 3: Combine & Deduplicate

After both reviews return:

1. Parse all findings from both reviewers
2. Deduplicate: if both flagged the same issue (same file, similar description), merge them and keep the more detailed description
3. Tag each finding with its source:
   - `[Claude]` - only Claude found it
   - `[Codex]` - only Codex found it
   - `[Both]` - both reviewers flagged it (higher confidence)
4. Sort by severity: critical first, then warning, then info

Present the combined list like this:

```
## Dual Review Results

Reviewed N files, M commits since branch point (<MERGE_BASE>).
Claude model: sonnet (or opus if --deep)

### Critical
1. [Both] `src/api.ts:42` - SQL injection in user query handler
   → Parameterize the query using prepared statements

### Warning
2. [Claude] `src/api.ts:87` - Unhandled promise rejection in async handler
   → Wrap in try/catch or add .catch() handler
3. [Codex] `src/utils.ts:15` - Function exceeds 80 lines, hard to maintain
   → Extract validation logic into helper function

### Info
4. [Codex] `src/types.ts:8` - Could use discriminated union for better type narrowing
   → Add a `kind` field to the union type
```

If neither reviewer found issues, congratulate the user and stop.

## Step 4: Prompt for Action

Ask the user what they want to fix using **AskUserQuestion** with these options:

- **"Fix all"**: Implement all fixes from the list
- **"Let me pick"**: User will specify which item numbers to fix (e.g. "1, 3, 5")
- **"Skip"**: Keep the review as reference, don't fix anything

If the user picks "Let me pick", ask a follow-up for which numbers.

## Step 5: Implement Fixes (if requested)

For each selected item, in priority order (critical → warning → info):

1. Read the relevant file
2. Implement the fix
3. Briefly note what was changed

After all fixes:

1. Run any available linting/tests if a test runner is detected
2. Show the full diff:
   ```bash
   git diff --stat
   git diff
   ```
3. Ask: **"Want to commit these fixes?"**
4. If yes, stage and commit with a descriptive message summarizing what was fixed

## Cleanup

```bash
rm -f /tmp/codex-review-output.txt
```
