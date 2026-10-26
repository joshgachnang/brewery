# User guide

Every IP says which user guide pages its feature adds, changes, or retires, so the guide
grows with the app instead of being written once and left to rot. A page explains one
feature in the words a user sees on screen: what it does, how to use it, and what it is
meant for. Chat agents read these pages to answer "how do I…" questions about the app, so
a page describes shipped behavior only. Grow plans the rows. Later stages read them; they
do not invent rows.

## Standardized spot

| Key | Default | What it holds |
| --- | --- | --- |
| `User guide` | `docs/user-guide/` | One page per feature at `<area>/<feature>.md`, plus a `README.md` index |

A repository whose layout differs, or that keeps no user guide, overrides the default with
a `## User guide conventions` table in its agent instructions (AGENTS.md or CLAUDE.md):

```markdown
## User guide conventions

| Key | Value |
| --- | --- |
| User guide | docs/help/ |
```

Resolve the key once: the table's value when the table names it, otherwise the default.

### Opting out

A repository with no end users (a library, a CLI, an internal tool) opts out with the
value `none`, optionally followed by a reason:

```markdown
| User guide | none — command-line tool with no in-app users |
```

When the resolved value is `none`, the user guide is off: Grow writes
`## User guide` as `None — user guide off`, and every other stage, check, and backfill
skips the section without failing. Opting out is the only way to skip it; a missing
directory at the resolved path is not an opt-out. When no guide exists at a resolved
path, the first IP that needs a page creates the directory and its `README.md` index.

## Page format

One file per feature at `<User guide>/<area>/<feature>.md`. `<area>` and `<feature>` are
kebab-case. The page opens with frontmatter, then three fixed sections in this order:

```markdown
---
title: Set a due date on a todo
area: todos
audience: user
platforms: [web, ios, android]
questions:
  - How do I set a due date on a todo?
  - Can I change or remove a due date?
screens:
  - "app/(tabs)/index.tsx"
added: todos-due-date
---

# Set a due date on a todo

## What it does

A due date shows when a todo should be done. Todos with a date show it under the title.

## How to use it

1. On **Todos**, tap a todo.
2. Tap **Due date** and pick a day.
3. Tap **Save**.

To remove the date, open the todo, tap **Due date**, then tap **Clear**.

## Intended use

Use due dates for todos that must happen by a certain day. A due date does not send a
reminder.
```

| Field | Rule |
| --- | --- |
| `title` | The task in the user's words, usually a verb phrase. Matches the `#` heading. |
| `area` | The page's directory name. |
| `audience` | Who can reach the feature: `user`, `admin`, or `staff`. A chat agent never describes a page to someone outside its audience. |
| `platforms` | Where the feature ships: any of `web`, `ios`, `android`. |
| `questions` | One to five "how do I…" or "can I…" questions a user would type that this page answers. Retrieval matches on these. |
| `screens` | Optional. Repository-relative source paths of the screens the steps visit, as a block list of quoted strings, since paths such as `[id].tsx` break inline YAML lists. |
| `added` | The slug of the IP that added the page, or `user-guide-backfill`. |
| `updated` | Optional. The slug of the latest IP that changed the page. |

Sections:

- `## What it does`: one to three sentences on what the feature does for the user.
- `## How to use it`: numbered steps a user can follow without guessing, naming on-screen
  labels in **bold**. Follow-up variations go in short paragraphs after the steps.
- `## Intended use`: what the feature is for, and what it is not for or does not do.
  This is where a chat agent learns to say "that's not what this is for".
- Optional `## Related`: links to other guide pages, by relative path.

## Guide-entry bar

Every page meets this bar:

- It describes behavior that ships in this change or is already shipped. No roadmap, no
  "coming soon".
- It uses the words a user sees: screen titles, button labels, menu names. No code,
  component names, routes, model or field names, test IDs, or internal jargon.
- Each step names where the user is and what they press or enter, and the steps reach
  the outcome `## What it does` promises.
- It holds no personal or health information, real names, real accounts, secrets,
  internal URLs, or staff-only procedures on a `user` page. Examples use obviously fake
  data.
- `audience` and `platforms` match who can actually reach the feature.

"Use the feature as needed", steps that skip a screen, or text that restates the title
does not meet the bar.

## IP table

Every IP has a `## User guide` section. It may be `None — <reason>`, but it may not be
missing. `None — no user-visible change` is the usual entry for backend-only, refactor, or
tooling work.

| ID | Page | Change | Audience | Written in |
| --- | --- | --- | --- | --- |
| G1 | `docs/user-guide/todos/due-dates.md` | new | user | T2 |

- `ID` is `G<n>`, unique within the IP.
- `Page` is the repository-relative page path under the resolved `User guide`.
- `Change` is `new`, `update`, or `retire`. `retire` deletes the page and its index entry
  when the feature is removed.
- `Audience` is the page's `audience` value.
- `Written in` is the one task that delivers the behavior. That task writes the page.

Every acceptance criterion that changes what a user sees or does maps to a row, or the IP
gives the reason it does not (for example: covered by an existing page, which is named).

## Index

`<User guide>/README.md` lists every page in one table, grouped by area:

```markdown
| Area | Page | Audience | Title |
| --- | --- | --- | --- |
| todos | [due-dates.md](todos/due-dates.md) | user | Set a due date on a todo |
```

A stage that adds, renames, or retires a page updates this table in the same commit.

## Stage duties

| Stage | Duty |
| --- | --- |
| Grow | Plans the `## User guide` rows, or `None — <reason>`. |
| Pick | Writes or edits each page whose row names the current task, in that task, at the row's path, and updates the index. |
| Roast | Checks each page this task owns against the guide-entry bar and against the shipped screens: every label a step names exists, and the steps reach the outcome. Walks the steps in a browser when it can reach one. |
| Brew | Confirms every row's page exists (or is gone, for `retire`), the index matches, and the repository's guide check passes. Sets `updated` on changed pages. |
| Taste | After a fix that changes user-visible behavior, updates the affected pages in place before the push. |

A page whose steps no longer match the shipped screens is a failing row, the same as a
failing test.

## Legacy rule

An IP approved before this contract that lacks `## User guide` is read as `None —
predates contract`. Stages warn once in their result and do not fail. A revised legacy IP
gains the section in the Grow invocation that revises it. Features shipped before the
contract are covered by the `backfill-user-guide` skill.
