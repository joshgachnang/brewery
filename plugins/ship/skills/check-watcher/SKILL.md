---
name: check-watcher
description: Monitor GitHub Actions checks and automatically fix failures
disable-model-invocation: true
model: sonnet
---

# Check Watcher

Monitor GitHub Actions checks and auto-fix failures. Designed to be called standalone or from other skills.

## Instructions

1. Get the PR number:
   ```bash
   gh pr view --json number -q .number
   ```
   If no PR exists, inform the user and exit.

2. Wait for CI to finish using `--watch` (no manual polling):
   ```bash
   gh pr checks --watch --fail-fast
   ```
   - All passing → go to step 6
   - Failed → continue to step 3

3. Get failure details:
   ```bash
   gh run view <run-id> --log-failed
   ```

4. Determine if flaky or real:
   - Compare failed files/tests against `gh pr diff` — is the failure in code you changed?
   - Check for flaky signals: timeouts, race conditions, ECONNRESET, intermittent assertions
   - If flaky (not in your code + flaky signals), rerun once: `gh run rerun <run-id> --failed`
   - Run `gh pr checks --watch --fail-fast` again. If still failing, file an issue and move on:
     ```bash
     gh issue create --title "Flaky test: <test name>" --body "<error details and job link>"
     ```

5. If failure IS related to PR changes:
   - Fix the code
   - Run lint and compile locally to validate
   - Commit and push (no AI attribution, no conventional prefixes)
   - Return to step 2

6. When all checks pass, check for bot review comments:
   ```bash
   gh api repos/:owner/:repo/pulls/<pr_number>/comments --jq '.[] | select(.user.type == "Bot") | "\(.path):\(.line) @\(.user.login): \(.body)"'
   ```
   Report any actionable bot comments found. Do NOT auto-fix — just report them.

7. Print the PR link:
   ```bash
   gh pr view --json title,url -q '"**\(.title)** — \(.url)"'
   ```

Cap fix attempts at $MAX_ATTEMPTS (default: 5).

## Arguments

$MAX_ATTEMPTS: Optional max fix attempts before stopping (default: 5)
