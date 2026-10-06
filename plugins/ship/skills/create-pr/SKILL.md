---
name: create-pr
description: Create a draft pull request for the current branch
disable-model-invocation: true
model: sonnet
---

# Create Pull Request

Create a pull request for the current branch.

## Instructions

1. First ensure changes are committed and pushed:
   ```
   git status
   git log origin/master..HEAD --oneline
   ```

2. If there are uncommitted changes, commit them first (run `/commit` command).

3. Push the branch if not already pushed:
   ```
   git push origin HEAD
   ```

4. Create the pull request:
   ```
   gh pr create --title "<title>" --body "<body>" --draft
   ```

   Guidelines for the PR:
   - Title: Clear, concise summary of the changes
   - Do not use prefix commit format (feat:, fix:, chore:, etc.)
   - Do not mention AI, Claude, or any AI assistant in the title or body
   - Do not add "Generated with Claude" or similar footers
   - Always create as draft

   **PR Body Structure:**

   ```markdown
   ## Summary

   [What changed and why — 2-4 sentences]

   ## Human Testing Steps

   - [ ] [Step-by-step instructions a reviewer can follow to verify the change works]
   - [ ] [Cover happy path and at least one edge case]

   ## Changes

   - [Bullet list of specific changes]

   ## Automated Tests

   - [Tests that ran and passed, or "No automated tests"]
   ```

5. Return the PR URL to the user.

## Arguments

$DESCRIPTION: Optional description for the PR title and body
