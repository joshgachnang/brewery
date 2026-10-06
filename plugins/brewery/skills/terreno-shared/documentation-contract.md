# Documentation contract

Human-facing docs are the architecture source. Code implements them. Skills never treat
docs as optional commentary.

## Always read docs first

Before shaping, implementing, verifying, or submitting:

1. Open the repository's architecture and domain docs for the affected area.
2. Prefer tutorials, how-to guides, reference, and explanation over tribal comments.
3. Reconstruct current behavior from those docs plus code/tests. If they disagree, the
   change must resolve the disagreement in the same slice.
4. Do not invent architecture from the diff alone when docs exist.

If the repository has no docs for the affected area, create them in this slice.

## Always update docs

Update docs in the same slice as the behavior when any of these change:

- public API, CLI, env, config, routes, models, permissions
- user-visible UI or operator workflow
- architecture, data flow, ownership, or runtime topology
- verification, rollout, or compatibility rules

Skip docs only for a pure internal refactor that does not change those. Record that skip
in the stage result `done` list. Missing docs for a user-visible or architectural change is `FAIL`,
not a follow-up.

## How to write

Use the repository's docs layout when one exists. Otherwise use Diátaxis:

| Kind | Put |
| --- | --- |
| Task a new user must complete | tutorial |
| Task an operator already understands | how-to |
| Facts: APIs, props, commands, env | reference |
| Why the system is shaped this way | explanation |

Rules:

- Lead with the next action or the canonical fact.
- Use the repository's standard headings. Do not invent parallel outlines.
- Prefer tables for options, ownership, and verification.
- Show one minimal example. Do not paste implementation chronology.
- Keep a page scannable: short sections, no recap, no preamble.
- Update the existing page in place. Split only when a page covers two jobs.
- Generated reference must be regenerated; never hand-edit generated output.
- Agent-facing rules/skills stay in their canonical source and are regenerated after.

## Done when

- A stranger can find the behavior from docs without reading the PR.
- Architecture docs match the shipped design.
- Examples and commands in docs are current.
- The stage result `done` list names every docs file created or updated.
