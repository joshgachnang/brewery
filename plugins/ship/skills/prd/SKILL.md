---
name: prd
description: Create a Shape Up-style PRD by gathering context, pushing back with hard questions, publishing to a Linear project, and stress-testing the plan
disable-model-invocation: true
---

# PRD: Product Requirements Document

Create a Shape Up-style PRD by gathering context, scanning for related/overlapping PRDs, pushing back with hard questions, drafting with Playwright-ready testing steps, publishing to a Linear project, and then red-teaming the plan before finalizing.

## Arguments

$ARGUMENTS: Feature name and description in the format "Feature Name: description of the feature". The description can be as brief or detailed as the user wants.

## Instructions

### Phase 0: Ensure Correct Repository

1. **Check the current working directory.** If the current directory is not inside the Flourish repo (`/Users/joshgachnang/Documents/Flourish`), stop and tell the user: "This command must be run from the Flourish repo. Please `cd /Users/joshgachnang/Documents/Flourish` and try again."

2. **Fetch and checkout latest master.** Run:
   ```
   git fetch origin
   git checkout master
   git pull origin master
   ```
   If there are uncommitted changes that prevent checkout, warn the user and ask how to proceed (stash, commit, or abort).

### Phase 1: Gather Context & Scan for Related PRDs

1. **Parse the argument.** Extract the feature name (before the colon) and description (after the colon). If `$ARGUMENTS` is empty or missing a description, ask: "What feature do you want to write a PRD for? Give me a name and a brief description."

2. **Read local documentation first.** Before touching code, build context from existing docs:
   - Read `docs/features/FEATURE_INDEX.md` to understand the feature landscape
   - Glob `docs/features/*.md` and read any FDs related to the topic
   - Glob `docs/implementationPlans/*.md` and read any IPs related to the topic
   - Read `CLAUDE.md` for project conventions

3. **Scan for related and overlapping PRDs.** This is mandatory — never skip it.
   - Use `mcp__linear__list_projects` to get all projects and scan for anything related to this feature area
   - Use `mcp__linear__list_issues` and/or `mcp__linear__research` to search for issues with keywords from the feature description
   - Search specifically for issues with "PRD:" in the title to find all existing PRDs
   - For each related PRD/project found, read its full description to understand overlap
   - **Flag overlaps explicitly.** If you find PRDs that cover similar ground, overlapping user flows, or features that would interact with this one, call them out clearly. The user needs to decide: subsume, depend on, or differentiate.

4. **Explore the codebase** for deeper understanding:
   - Search for relevant code patterns, models, screens, routes, and components
   - Understand how similar features are currently implemented
   - Note any technical constraints or dependencies

5. **Investigate existing tests** for testing step patterns:
   - Glob `e2e/*.spec.ts` to find existing Playwright tests
   - Read tests that cover similar screens, flows, or features to understand:
     - What testIDs already exist on relevant screens
     - What user flows are already covered
     - What test patterns and helpers are established
     - What fixtures and test data exist
   - This research directly informs the Testing Steps section in Phase 3

6. **Present your findings** to the user:
   - Brief summary of what exists today (from docs + Linear + code)
   - **Related PRDs and projects found** — with explicit overlap analysis
   - Key technical context that will shape the PRD
   - Summary of relevant existing tests and testID coverage

### Phase 2: Question & Push Back

This is the most important phase. Do NOT draft the PRD yet. Instead, challenge the user's thinking with pointed questions. Ask 4-8 questions across these dimensions:

**Problem validation:**
- Who specifically has this problem? Staff, patients, or both? How do you know?
- What are they doing today instead? Why is that insufficient?
- How painful is this really? Is it a hair-on-fire problem or a nice-to-have?

**Scope:**
- What's the smallest version of this that would be useful?
- What are you explicitly NOT building? Where do you want to draw the line?

**Design & UX:**
- How should staff vs patients discover and experience this feature?
- What happens when things go wrong? (errors, edge cases, permissions)
- Are there existing patterns in the app you want to follow or break from?

**Technical concerns** (based on what you found in the codebase):
- Are there known constraints or dependencies that could affect feasibility?
- Are there external service or third-party dependencies?

**Overlap & coordination** (based on related PRDs found):
- If related PRDs were found, ask how this feature relates to them
- Should this subsume, extend, or depend on existing work?
- Are there sequencing concerns?

**Business context:**
- How does this fit with other priorities?
- How will you know this was successful?

Present these as a numbered list. Wait for the user to respond before proceeding. If their answers reveal new ambiguity, ask follow-up questions. Keep pushing until the feature is well-defined.

### Phase 3: Draft the PRD

Once you have enough clarity, write the PRD in markdown using this structure. This is a **product design document**, not a technical spec. It defines the problem, who it affects, and what success looks like. It must NEVER include API design, data models, database schemas, technical architecture, implementation phases, or engineering details — those are entirely the engineer's domain.

```markdown
# PRD: {Feature Name}

## Problem

{Describe the problem from a user standpoint. What pain are users experiencing? What workflow is broken or missing?}

{Describe the problem from a company standpoint. What business value does solving this unlock? Include business case if reasonable — revenue impact, retention, efficiency gains, compliance, etc.}

## Solution

{Describe the high-level solution direction. Walk through the user journey at a conceptual level. Do NOT prescribe specific screens, components, or technical implementation — that's for the engineer to decide.}

{If there are multiple user roles affected, describe how each role's experience changes.}

## Acceptance Criteria

{List high-level acceptance criteria that define "done" for this feature. These should be user-observable outcomes, not implementation details.

Write these as plain statements of what should be true when the feature ships. Keep them broad enough that the engineer has room to choose the right approach.}

1. {User can do X}
2. {Staff can see Y}
3. {System handles Z gracefully}
...

## Testing Steps

{These steps must be concrete enough to convert directly into Playwright e2e tests. Each step should map to a `test()` block. Write them as user behaviors, not implementation details.}

{Reference any existing test patterns discovered in Phase 1. If existing tests cover adjacent flows, note which test files to extend vs. create new.}

### Preconditions
- {Auth state required: logged in as staff / patient / unauthenticated}
- {Data state required: specific records, settings, or configurations that must exist}
- {Any setup steps}

### Test Scenarios

**Happy path:**
1. {User navigates to X screen}
2. {User fills in / interacts with Y}
3. {User submits / confirms}
4. {Expected outcome is visible: Z appears, navigation occurs, data updates}
5. {Verify final state}

**Validation & error handling:**
1. {User submits empty/invalid form — error messages appear}
2. {User enters invalid data — specific validation feedback shown}
3. {Network/server error — graceful error state displayed}

**Edge cases:**
1. {Empty state — what does the user see with no data?}
2. {Permission boundaries — what happens if unauthorized?}
3. {Concurrent usage — what if another user modifies the same data?}
4. {Large data sets — does the feature handle many items?}

**Cross-role testing** (if applicable):
1. {Staff creates/modifies X — patient sees Y}
2. {Patient performs action — staff dashboard reflects change}

### testID Requirements
{List the testIDs that will need to exist for these tests. Use the `{screen}-{element}-{qualifier}` naming convention.}

- `{screen}-{element}-{qualifier}` — {what it identifies}
- ...

## Related PRDs & Projects

{List all related PRDs, projects, and issues found during research. For each, note the relationship: depends-on, extends, overlaps, supersedes, or related.}

- {PRD/Project identifier} — {title} ({relationship})
- ...

## Open Questions

{Any unresolved questions or decisions that came up during the discussion.}

## Risks & Rabbit Holes

{Product-level risks — areas where scope could spiral, requirements are ambiguous, or user expectations might not match reality. Do NOT list technical risks like "database migrations" or "API versioning" — those are for the engineer to identify.}
```

Present the full draft to the user and ask for feedback. Iterate until they're satisfied.

### Phase 4: Red Team the PRD

Before moving to Linear, step back and critically attack the plan you've put together. This is a structured adversarial review — not a formality, but a genuine attempt to find weaknesses.

**Review dimensions:**

1. **Scope creep detector.** Re-read every acceptance criterion and testing step. Flag anything that feels like it's growing beyond the original problem statement. Ask: "Is this really v1, or did we sneak in v2 features?"

2. **Assumption audit.** List every assumption the PRD makes — about user behavior, about existing system capabilities, about data availability. Challenge each one: "Do we know this is true, or are we hoping?"

3. **Gap analysis.** Look for things the PRD doesn't cover that it should:
   - What happens on first use vs. returning use?
   - What about mobile vs. desktop (if applicable)?
   - Are there onboarding or discovery gaps?
   - Are the testing steps actually comprehensive, or did we miss a critical flow?

4. **Overlap conflicts.** Revisit the related PRDs found in Phase 1. Are there actual conflicts — places where this PRD's solution contradicts or duplicates another PRD's approach? Flag them.

5. **Feasibility gut check.** Based on the codebase exploration, is there anything in this PRD that feels disproportionately expensive for its value? Point it out.

6. **Testing completeness.** Review the testing steps against the acceptance criteria — is every AC covered by at least one test scenario? Are there test scenarios that don't trace back to an AC (sign of scope creep)?

Present your critique as a numbered list of concerns, each with a severity:
- **Blocker** — must resolve before creating the project
- **Risk** — should discuss, may or may not change the PRD
- **Nit** — minor, note for the implementer

Wait for the user to respond. Update the PRD based on their decisions. Repeat if new concerns emerge.

### Phase 5: Configure Linear Project

Ask the user these questions using AskUserQuestion:

**Question 1: Project or existing project**
- "Should I create a new Linear project for this PRD, or add it to an existing project?"
- If existing: list the related projects found in Phase 1 and ask which one
- If new: proceed with creation

**Question 2: Assignment**
- "Should this project be assigned to you (josh@flourish.health)?"
- Options: "Yes, assign to me" / "No, leave unassigned"

**Question 3: Status**
- "What status should this project start in?"
- Options: "Planned" / "In Progress" / "Backlog"

### Phase 6: Create or Update in Linear

1. **Discover Linear tools.** Use ToolSearch to find available Linear MCP tools (search for "mcp__linear"). You'll need tools for:
   - Listing teams (to pick the right team)
   - Listing/creating projects
   - Listing issue statuses
   - Creating issues
   - Saving projects

2. **Get team info:**
   - List teams and use the appropriate one (if multiple, ask the user)

3. **Create or update the Linear project:**
   - If creating new:
     - Name: `{Feature Name}`
     - Description: The full PRD markdown from Phase 3 (with red team revisions from Phase 4)
     - Status: The status chosen in Phase 5
     - Lead: josh@flourish.health if chosen, otherwise unassigned
   - If updating existing:
     - Update the project description with the PRD content
     - Note what was changed

4. **Create the PRD issue within the project:**
   - Title: `PRD: {Feature Name}`
   - Description: The full PRD markdown
   - Assign to the project
   - Status: Map to the appropriate issue status

5. **Create the tracking issue within the project:**
   - Title: `{Feature Name}`
   - Description: `Tracking issue for {Feature Name}. PRD: {PRD issue identifier}.`
   - Link it to the PRD issue
   - Assign to the same project

6. **Link related issues.** For any related PRDs/issues found in Phase 1, add comments or links connecting them to this new project.

### Phase 7: Report

Present a summary of everything created:

```
## PRD Created

**Project:** {project name} ({new / updated})
**PRD Issue:** {identifier} — PRD: {Feature Name}
**Tracking Issue:** {identifier} — {Feature Name}
**Status:** {Planned / In Progress / Backlog}
**Assigned:** {josh@flourish.health / Unassigned}

### Related PRDs & Projects
- {identifier} — {title} ({relationship: overlaps / depends-on / extends})

### Red Team Summary
- {N} blockers resolved, {N} risks acknowledged, {N} nits noted

### Testing Coverage
- {N} test scenarios defined across {N} categories
- testIDs required: {N}
- Existing tests to extend: {list files}
- New test files needed: {list}
```

## Key Principles

- **Push back first, write second.** The PRD should be shaped by hard questions, not just transcribed from the user's initial idea. Phase 2 is the most important phase.
- **Be opinionated.** If something sounds like scope creep, over-engineering, or a solution in search of a problem, say so.
- **Research before writing.** Always check docs/features, docs/implementationPlans, Linear projects, and Linear issues before drafting.
- **Always scan for overlap.** Every PRD must be checked against existing PRDs and projects. Never create in isolation.
- **Testing steps are mandatory.** Every PRD must include concrete, Playwright-convertible testing steps. Investigate existing tests to inform these. Test scenarios must trace back to acceptance criteria.
- **Red team every PRD.** After drafting, critically attack the plan. Find the weaknesses before implementation does.
- **Always use Linear projects.** PRDs live in Linear projects, not as standalone issues. Create or update a project every time.
- **Stay high-level.** The PRD defines the problem and desired outcomes. Never include API design, data models, technical architecture, implementation phases, appetite/sizing, or engineering details — those are entirely the engineer's and team's domain.
- **Shape Up style.** Focus on the problem, not exhaustive specs. Leave room for the implementer to make decisions within the defined boundaries.
- **Iterate with the user.** The conversation IS the process. Don't rush to Linear — get the PRD right first, including surviving red team review.
