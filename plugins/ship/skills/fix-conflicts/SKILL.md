---
name: fix-conflicts
description: Pull latest from master, resolve merge conflicts, validate with lint/compile checks, and monitor CI
disable-model-invocation: true
---

# Fix Conflicts

Pull latest from master, resolve merge conflicts, validate with lint/compile checks, and monitor CI.

## Instructions

1. Ensure the working tree is clean before starting:
   ```
   git status
   ```
   - If there are uncommitted changes, ask the user whether to stash them or abort

2. Fetch and merge the latest master into the current branch:
   ```
   git fetch origin master
   git merge origin/master
   ```

3. Check for merge conflicts:
   ```
   git diff --name-only --diff-filter=U
   ```
   - If there are no conflicts, skip to step 5

4. For each conflicted file:
   - Read the file and understand both sides of the conflict
   - Resolve the conflict by combining changes intelligently, preserving intent from both sides
   - After resolving all conflicts in a file, stage it:
     ```
     git add <file>
     ```
   - After all conflicts are resolved, complete the merge:
     ```
     git commit --no-edit
     ```

5. Run lint and compile checks at the project root:
   ```
   git rev-parse --show-toplevel
   ```
   - Run linting:
     ```
     cd <project-root> && bun lint
     ```
     - If linting fails, fix the issues and re-run until passing
   - Run type compilation/checking:
     ```
     cd <project-root> && bun compile
     ```
     - If compilation fails, fix the type errors and re-run until passing

6. If any fixes were needed in step 5, stage and commit them:
   - Review the changes made
   - Create a commit with a clear message describing what was fixed
   - Do not use prefix commit format (feat:, fix:, chore:, etc.)
   - Do not mention AI, Claude, or any AI assistant

7. Push the changes:
   ```
   git push origin HEAD
   ```

8. Run check-watcher by invoking `/check-watcher`:
   - This monitors GitHub Actions checks
   - If checks fail, it will automatically read failures, fix them, and push again
   - Continue until all checks pass

## Arguments

None
