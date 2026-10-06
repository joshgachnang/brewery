---
name: research
description: "Research: conduct thorough multi-phase research on a topic, producing a comprehensive document"
disable-model-invocation: true
---

# Research: $ARGUMENTS

## Objective

Conduct thorough research on the topic below. Produce a comprehensive research document that can later drive an implementation plan.

**Topic:** $ARGUMENTS

## Instructions

### Phase 1: Understand & Scope

1. Parse the topic/problem statement. If it's vague, state your assumptions clearly.
2. Before diving in, briefly tell the user what you plan to investigate and ask if there's anything specific they want covered.

### Phase 2: Deep Research

Investigate using all available resources:

**Codebase:**
- Read relevant source files in depth — understand how things work, not just what exists
- Search for existing patterns, conventions, and dependencies
- Look at models, routes, screens, components, configs, and tests related to the topic
- Check `docs/`, `README.md`, `CLAUDE.md`, and any feature documentation
- Review related packages/libraries used in the codebase (e.g., `@terreno/` packages)

**External:**
- Search the web if external context is needed (APIs, libraries, best practices)
- Check documentation for relevant third-party tools or services

**Patterns:**
- How does the codebase handle similar concerns already?
- What conventions exist for the relevant domain (models, routes, screens, etc.)?
- Are there feature flags, activity logs, notification systems, or other infrastructure to be aware of?

### Phase 3: Present Findings

Output the **full research document** directly in chat using this structure:

```markdown
# Research: [Topic]

## Summary
2-3 sentence executive summary of findings and recommendation.

## Context
- What problem are we solving?
- Why does it matter?
- What's the current state?

## Findings

### [Finding 1 — e.g., "Existing Codebase Patterns"]
What you found, with file paths, function names, line numbers, and code snippets.

### [Finding 2 — e.g., "Library/API Options"]
Options evaluated, with pros/cons.

### [Finding 3 — e.g., "Constraints & Risks"]
Technical constraints, breaking changes, performance concerns, conflicts with existing work.

(Add more sections as needed)

## Options Considered
| Option | Pros | Cons | Effort |
|--------|------|------|--------|
| A      |      |      |        |
| B      |      |      |        |

## Recommendation
Which option to pursue and why. Be opinionated — don't just list options.

## Open Questions
Things that need human input or further investigation.

## References
- Links to docs, files, PRs, or external resources consulted.
```

### Phase 4: Iterate

After presenting, ask:

> **Anything you want me to dig deeper on, adjust, or investigate further?**

If the user gives feedback:
- Investigate their questions or concerns
- Update the relevant sections
- **Re-output the full updated research document** so they always have the complete picture

Repeat until the user is satisfied.

### Phase 5: Save & Wrap Up

Once the user confirms they're happy with the research, write the final version to `research.md` in the project root and say:

> **Research saved to `research.md`. Ready to turn this into an implementation plan when you are.**

## Key Principles

- **Be specific** — Include file paths, function names, line numbers, dependency versions, and code snippets. The reader should have enough context to write an implementation plan without re-doing research.
- **Be opinionated** — Recommend an approach and explain why.
- **Always output the full document** — Never output partial updates. The user should be able to copy the whole thing at any point.
