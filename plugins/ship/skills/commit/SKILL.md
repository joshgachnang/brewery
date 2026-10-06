---
name: commit
description: Create a commit for the current staged/unstaged changes with a clear, accurate message
disable-model-invocation: true
model: sonnet
---

# Commit Changes

Create a commit for the current staged/unstaged changes.

## Instructions

1. Check git status and diff to understand what changed:
   ```
   git status
   git diff
   git diff --cached
   ```

2. Stage changes appropriately and create a commit:
   - Review the actual changes to write an accurate commit message
   - Keep the first line under 72 characters
   - Add a body if more context is needed
   - Do not use prefix commit format (feat:, fix:, chore:, etc.)
   - Do not mention AI, Claude, or any AI assistant
   - Do not make the commit coauthored by any AI
   - Do not add "Co-Authored-By" trailers

3. Do NOT push unless explicitly asked.

## Arguments

$DESCRIPTION: Optional description to guide the commit message
