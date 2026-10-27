# GitHub attention contract

Human attention is the scarcest resource. A PR must be understandable in one glance.
Put detail behind disclosure controls and post comments only when they cause a human
decision or preserve context that the diff cannot.

## Pull request title

Format: `[ticket] Short feature title`

- `ticket` is the attached tracker id, copied in that tracker’s own form:
  Linear `TEAM-n` (`[FH-1632]`) or GitHub `#n` (`[#412]`).
- Prefer Linear when both are attached. If none is attached, omit the brackets
  and use only the feature title.
- The feature title names what the change does, short and memorable.
- Use at most 72 characters including the ticket prefix.
- Do not use conventional-commit prefixes (`feat:`, `docs:`, `fix:`, `chore:`).
- Do not use lifecycle labels (`IP Approved`, `Task list`) or other status words.
- Do not put implementation detail in the title.

Use:

```text
[FH-1632] Standardize planning PR titles
[#412] Windowed admin table sync
Rate-limit Better Auth sign-in
```

Do not use:

```text
IP Approved: Task list for syncdb
feat: add PR title format
[FH-1632] IP Approved — Grow artifacts
docs: update attention contract
```

## Pull request body

Use exactly these top-level headings, in this order:

```markdown
## Why

<The IP's initial justification: problem, user/repository impact, and canonical issue/spec.>

Implements `<plan path>` (T1–T3). Closes #<n>.

## What changed

- <Brief overview of the approved IP and its intended outcomes; maximum five bullets.>

## Verification

| Status | Scope | Evidence / action |
| --- | --- | --- |
| ✅ Tested | <behavior or risk> | `<command>` or artifact link |
| 🧭 Test instructions | <feature or workflow> | <exact steps a reviewer can follow> |
| ⚠️ Not tested | <remaining risk> | <exact reviewer test or action> |
| ⚠️ Not tested | Regression cases `<AREA-NNN>`, `<AREA-NNN>` | Walk them in [`<suite file>`](<link>) |
```

Rules:

- Keep the visible body under 250 words.
- Spell the headings exactly `## Why`, `## What changed`, and `## Verification`. The
  approval bot reads sections by heading; a `What`, `Summary`, or `Testing` heading reads
  as a missing section and raises the PR's risk level.
- When the PR implements a plan, end `Why` with one line naming the plan file's
  repository path in backticks and the task ids it delivers (`T1–T3`, `Tasks 2.1–2.2`).
  When it closes an issue, add `Closes #<n>`. The approval bot finds the plan only from a
  literal path, the stage result's `ip`, or a plan file changed in the diff; without one it
  scores plan match at most 1 out of 3.
- Initialize `Why` from the IP's original justification. Preserve the problem and
  motivation that caused the IP to exist; do not replace them with recent-turn context.
- Initialize `What changed` with a short overview of the approved IP and intended
  outcomes. Explain the feature, not the implementation chronology or last agent turn.
- Keep `Why` and `What changed` stable while the PR's purpose and scope remain
  accurate. Update them only for an approved scope change, a factual correction, or a
  human edit.
- Always include executable testing instructions in `Verification`, even after all
  automated tests pass. A reviewer must be able to reproduce the important behavior.
- Update testing instructions, evidence, and remaining-risk rows whenever verification
  changes. Do not regenerate the rest of the body from the latest turn.
- Omit empty rows and optional sections. If nothing remains untested, omit the
  `Not tested` row.
- When the PR adds or changes manual regression cases in the testing-plan suite
  files, list every such case ID in one row that links its suite file. Use
  `⚠️ Not tested`, with walking the cases as the reviewer action, until a person walks
  every listed case on this branch; then use `✅ Tested`, naming who walked them and
  the evidence. Omit the row when the PR adds or changes no case.
- Put the most decision-relevant verification first.
- Name what a check proves; a command alone is not evidence. Write the outcome next
  to the command (`` `bun test api` → 412 pass ``).
- Use only the three-column table, with the status mark (`✅`, `🧭`, or `⚠️`) in the
  first cell of every row. The approval bot reads verification from those marks; a
  bullet list or a `| Check | Result |` table without them reads as no verification.
- Link one canonical issue/spec in `Why`; do not add a separate metadata section.
- Embed only the minimum screenshot/video needed to prove user-visible behavior.
- Put migration notes, full check logs, compatibility matrices, unusual implementation
  detail, and the stage-result YAML in one optional block after the table:

  ```html
  <details>
  <summary>Details</summary>
  Concise supporting detail.
  <details>
  <summary>Stage result</summary>
  Compact v2 YAML for the next skill. Never duplicate it in the visible body.
  </details>
  </details>
  ```

- In the stage-result YAML, set `ip` to the plan's filename without `.md` (for
  `<plans dir>/2026-10-01-post-cache.md`, `ip: 2026-10-01-post-cache`), and
  start each `done` entry with its task id (`T2 Roast PASS`). A later stage that rewrites
  the block keeps `ip` and the delivered task ids.
- Never put stage-result YAML in the visible body or a comment. Omit the inner Stage
  result toggle when this PR is not a lifecycle handoff.

- Do not add checklists, type-of-change sections, commit lists, generated summaries,
  badges, repeated acceptance criteria, or routine CI state.
- Preserve human-authored text when updating. Reformat it only when explicitly asked.

## Comments and review replies

Default to silence.

Post only when at least one is true:

1. A human must make a decision or take an action.
2. A review thread needs a non-obvious explanation that the diff cannot supply.
3. A requested change is intentionally not made and the tradeoff must be recorded.

Do not post progress updates, thanks, summaries of the PR body, test reports already in
the body, “ready for review” messages, CI notifications, or preview/demo URLs. Chat
already prints PR deployment links per [`pr-deployments.md`](pr-deployments.md).

Use the narrowest location:

- Reply in the existing review thread instead of posting a top-level comment.
- Update the PR body instead of commenting when verification evidence changes.
- Resolve an addressed thread silently when the fix is obvious from the diff.

Write at most three short sentences:

```markdown
**Action needed:** <one decision/action and why it blocks>.

<details>
<summary>Evidence</summary>

<only the detail needed to decide>

</details>
```

For a non-obvious resolved thread:

```markdown
Fixed in `<sha>`: <what changed and why this approach>.
```

Never split one update across several comments. Never post speculative findings. Never
quote long logs; link them or place the decisive excerpt in the expandable block.
