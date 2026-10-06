---
name: review
description: Comprehensive multi-agent code review — runs health check, then parallel focused reviews, and combines into a single report
allowed-tools: Task, Bash(claude *), Bash(which *), Bash(command *), Read, Write, Glob, Grep
model: claude-opus-4-6
disable-model-invocation: true
---

# Comprehensive Multi-Agent Code Review

ultrathink

You are a review orchestrator. Your job is to coordinate a comprehensive code review of: **$ARGUMENTS**

If no specific files/directories were provided, review the most recently changed files on the current branch vs the default branch (main/master).

---

## Phase 0: Health Check

Before doing anything else, verify that Claude Code (codex) is working:

1. Run `which claude` to confirm it's installed
2. Run `claude --version` to confirm it runs and capture the version
3. Run `claude /doctor` to check installation health (if available)

If any of these fail, **stop and report the issue to the user** before proceeding. Include the error output.

---

## Phase 1: Gather Context

Determine what to review:
- If `$ARGUMENTS` specifies files or directories, use those
- Otherwise, run `git diff --name-only $(git merge-base HEAD main || git merge-base HEAD master)..HEAD` to find changed files
- Run `git diff --stat` to understand the scope of changes
- Collect a file manifest of what will be reviewed

Store this file list — every sub-agent in Phase 3 will need it.

---

## Phase 2: Comprehension & Design Review

Before launching sub-agents, YOU (the orchestrator) must read all the changed files and present the following to the user. This is a gate — the user should see this before the parallel reviews begin.

### 2a. Comprehension Check

Read every changed file. Then print a summary that proves you understand the code:

> **What this code does:**
> [For each file or logical group of files, explain in plain English what the code is doing, what problem it solves, and how it fits into the broader system. Be specific — reference function names, data flow, and key decisions the author made.]

### 2b. Is There a Better Way?

For each file or logical change, evaluate:

> **Better approaches:**
> [For each area where a meaningfully better approach exists, describe the alternative and why it's better. Consider: standard library features, well-known patterns, simpler algorithms, better data structures, existing utilities in the codebase that could be reused. If the current approach is already good, say so — don't invent alternatives for the sake of it.]

### 2c. Refactoring Assessment

> **Refactoring opportunities:**
> [Identify any refactoring that could improve the code — extract shared logic, reduce duplication, improve naming, simplify control flow, etc. For each opportunity, state whether it's **worth it** given the scope and complexity of the change. A small cleanup in a hot path is worth it; a large restructuring for marginal readability gains probably isn't. Be honest about the tradeoff.]

Print all three sections to the terminal. Then proceed to Phase 3.

---

## Phase 3: Parallel Focused Reviews

Launch ALL of the following sub-agents **in parallel** using the Task tool. Each one runs in its own context and reports back findings. For each, provide the file list from Phase 1 in the prompt.

### 3a. Comprehensive Review — Opus (sub-agent: `review-opus`)
Spawn a Task with `subagent_type: "review-opus"` (or `general-purpose` if custom agent not found).

Prompt it with:
> Perform a comprehensive code review of the following files: [file list].
> Cover: correctness, logic errors, edge cases, error handling, code organization, naming, readability, maintainability, adherence to project conventions.
> Use Read/Grep/Glob to examine the code thoroughly. Be specific with line references.

### 3b. Comprehensive Review — Sonnet (sub-agent: `review-sonnet`)
Spawn a Task with `subagent_type: "review-sonnet"` (or `general-purpose` if custom agent not found).

Prompt it with:
> Perform a comprehensive code review of the following files: [file list].
> Cover: correctness, logic errors, edge cases, error handling, code organization, naming, readability, maintainability, adherence to project conventions.
> Use Read/Grep/Glob to examine the code thoroughly. Be specific with line references.
> Also examine how the code fits within the broader codebase — check for duplication, inconsistencies with existing patterns, and missed reuse opportunities.

### 3c. Security Review (sub-agent: `review-security`)
Spawn a Task with `subagent_type: "review-security"` (or `general-purpose` if custom agent not found).

Prompt it with:
> Perform a focused SECURITY review of the following files: [file list].
> Check for: injection vulnerabilities (SQL, XSS, command injection), authentication/authorization flaws, secrets or credentials in code, insecure data handling, CSRF, path traversal, insecure deserialization, missing input validation, improper error disclosure, dependency vulnerabilities.
> Rate each finding as Critical / High / Medium / Low severity.
> Be specific with file names and line numbers.

### 3d. User Experience Review (sub-agent: `review-ux`)
Spawn a Task with `subagent_type: "review-ux"` (or `general-purpose` if custom agent not found).

Prompt it with:
> Perform a focused USER EXPERIENCE review of the following files: [file list].
> Check for: error messages (are they helpful?), loading states, accessibility (a11y), responsive design considerations, user-facing text quality, input validation feedback, empty states, edge case UX (what happens with 0 items? 10000 items?), consistent UI patterns, keyboard navigation.
> If the files don't have a UI component, note that and focus on API ergonomics / developer experience instead.

### 3e. Performance Review (sub-agent: `review-performance`)
Spawn a Task with `subagent_type: "review-performance"` (or `general-purpose` if custom agent not found).

Prompt it with:
> Perform a focused PERFORMANCE review of the following files: [file list].
> Check for: N+1 queries, missing indexes, unnecessary re-renders, large bundle imports, unoptimized loops, missing caching opportunities, memory leaks, blocking operations, unnecessary network calls, large payload sizes, missing pagination, inefficient data structures.
> Estimate impact where possible (e.g., "This N+1 will cause O(n) queries per request").

### 3f. Testing Review (sub-agent: `review-testing`)
Spawn a Task with `subagent_type: "review-testing"` (or `general-purpose` if custom agent not found).

Prompt it with:
> Perform a focused TESTING review of the following files: [file list].
> Check for: missing test coverage, untested edge cases, brittle tests, missing error case tests, test quality (are assertions meaningful?), missing integration tests, mock overuse, test naming clarity.
> Also check if tests exist at all for the changed files. Search for corresponding test files.
> Suggest specific test cases that should be added.

---

## Phase 4: Synthesize Report

After ALL sub-agents return, combine their findings into a single, well-organized report. Write this to `REVIEW_REPORT.md` in the project root.

### Report structure:

```markdown
# Code Review Report

**Date:** [today's date]
**Files Reviewed:** [count] files
**Review Scope:** [brief description]
**Claude Code Version:** [from health check]

## Executive Summary
[2-3 sentence overview of overall code quality and most critical findings]

## 🔴 Critical Issues
[Issues that MUST be fixed before merging — from any reviewer]

## 🟡 Important Issues
[Issues that SHOULD be fixed — from any reviewer]

## 🟢 Minor Issues & Suggestions
[Nice-to-haves and style suggestions]

## Security Findings
[Dedicated section with severity ratings]

## Performance Findings
[Dedicated section with impact estimates]

## UX / Developer Experience Findings
[Dedicated section]

## Testing Gaps
[Dedicated section with suggested test cases]

## Consensus & Conflicts
[Where Opus and Sonnet agreed, and where they disagreed — note both perspectives]

## Files Reviewed
[Full file list]
```

### Deduplication rules:
- If multiple reviewers flag the same issue, consolidate into one entry and note which reviewers caught it
- Prioritize by severity: Critical > High > Medium > Low
- Keep the most specific/actionable description from whichever reviewer provided it

---

## Phase 5: Present Results

After writing the report:
1. Print a brief summary to the terminal (executive summary + critical issues count)
2. Tell the user where to find the full report: `REVIEW_REPORT.md`
3. Ask if they want you to fix any of the critical issues
