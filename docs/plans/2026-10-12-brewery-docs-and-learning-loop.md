# Brewery docs layout and learning loop

**Date:** 2026-10-12
**Status:** in progress (tasks 1–9 done; task 10 waits until this has run for a while 2026-10-12)
**Design:** [brewery docs layout and learning loop](../specs/2026-10-12-brewery-docs-and-learning-loop-design.md)

## Goal

Every brewery run leaves a reviewable journal and persisted CI-failure evidence. A nightly `brewery cellar`
turns those, plus GitHub data from non-brewery sessions, into learnings, capped rules and skill edits, delivered as PRs.
Everything is built under `brewery/` and `dot_claude/skills/` so it can be split into the brewery repo afterwards.

## Decisions

- Borrow from Compound Engineering (learnings schema, one-per-run bar, retire/refresh). Don't install it or claude-smart.
- Learning runs as a batch over brewery artifacts and GitHub. It never reads raw Claude transcripts (PHI).
- `.terreno/brewery/<slug>/` is the source of truth. `.terreno/pipeline/<slug>.json` is a projection of it.
- The FD system is retired.
- Journals are committed on the PR branch under `docs/journal/`.
- Cellar runs per repo (`brewery cellar <owner/name>`); scheduling is configured by Josh on a host of his choice.
- Cellar only ever opens PRs, with at most 3 rule or skill changes per repo per night, and every change cites its evidence.

## Tasks

### 1. Layout scaffolding and conventions
- Done: `brewery/templates/{decision,learning,rules}.md`, embedded as text imports. The journal is rendered by code in task 4, so it has no template.
- Add `brewery/templates/{decision,learning,journal}.md` and a `learnings/RULES.md` template
  (Active capped at 15 / Retired / Proposals, adapted from `factory-retro`'s LESSONS.md).
- Learning frontmatter: CE fields (`title, date, category, module, problem_type, component, symptoms, root_cause,
  tags, retire_when`) plus `source` and `promoted_to`.
- `brewery init-docs` creates `docs/{decisions,journal,learnings}/` and adds a one-line pointer to the repo's
  CLAUDE.md/AGENTS.md.
- Verify: a unit test runs init-docs against a temp repo, and running it again is idempotent.

### 2. Pipeline-state projection
- Done: `src/pipeline.ts`. The test validates against the schema with a small in-test checker, which avoids adding ajv.
- In `src/state.ts`, on every save, also write `.terreno/pipeline/<slug>.json` that conforms to
  `dot_claude/skills/terreno-shared/execution-state.schema.json`.
- Verify: a unit test validates the projected file against the schema.

### 3. Persist CI failure evidence (`src/commands/finish.ts`)
- Done: `src/ci.ts`, `src/scrub.ts`, and `Ci.failedLog`. Flaky means green at the same sha the failure was recorded at.
- On a red snapshot, before Taste runs, write `ci/NNN-<check>.json`: check, run URL, head sha, and a scrubbed
  `gh run view --log-failed` tail (≤4KB).
- On green, record the fix sha. If the check passed on rerun, mark it `flaky`.
- Add a scrubber in `src/scrub.ts` (emails, phones, long digit IDs, token-like strings), with unit tests.
- Verify: a flow test with a fake `gh` that goes red then green produces a populated `ci/*.json` with `fixSha`.

### 4. Generated journal
- Done: `src/journal.ts`. It is opt-in, written only where `docs/journal/` exists.
  - It is committed with the learning in a single push at the first green, then finish waits for green again.
  - It is skipped for a standalone `brewery finish <pr>`, which has no IP or branch.
- `src/journal.ts` renders `state.json` + `steps/*.result.json` + `ci/*.json` into `docs/journal/YYYY-MM-DD-<slug>.md`:
  timeline, gates and answers, Roast fails and retries, CI failures and their fixes, agents used, durations.
- finish writes it and commits it on the branch before the final green check.
- Verify: a snapshot test on a fixture run.

### 5. Compound step in barrel and finish
- Done: one `compound` stage at the end of the run (`src/learn.ts`, `dot_claude/skills/compound/SKILL.md`),
  rather than one per retry, so the "at most one learning per run" bar holds.
  - It runs only when `struggles()` finds something.
  - `learn: off|local|shared` lives in config.
  - Rules are injected into every step header.
  - The skill also works by hand (`/compound`) in remote or web sessions.
- After a Roast FAIL→pass or a Taste fix, run a short agent step that writes **≤1** learning under `docs/learnings/`,
  or prints `Documentation skipped`. It applies CE's "would this recur?" bar and updates an existing learning rather than duplicating one.
- distill, cut and barrel prompts include `docs/learnings/RULES.md`, and distill greps `docs/learnings/` frontmatter for the request's area.
- Verify: a flow test with the fake agent checks the terminal signal is parsed and the file is placed.

### 6. Decisions promotion
- Done: `src/decisions.ts`. This is deterministic code, not an agent step. The `(durable)` marker goes on the ID cell of a Decisions row, and the promotion lands in the end-of-run commit.
- In the finish compound step: IP `## Decisions` items marked `(durable)` become `docs/decisions/NNNN-<slug>.md`,
  and the IP links to them.
- Update `distill/references/distilling.md` to explain the `(durable)` marker.

### 7. `brewery cellar <repo>` + `cellar` skill
- Done: `src/commands/cellar.ts`, `src/forge.ts` (a GitHub interface, faked in tests), and `dot_claude/skills/cellar/SKILL.md`.
  - Journals are read from git on the default branch rather than local run state, so runs from every host count.
  - `shared` mode lists skill proposals in the PR body. It doesn't edit skills yet, because the brewery skills don't have their own repo yet; revisit after task 10.
  - Not yet verified against real `gh` (it wasn't logged in where this was built).
- One repo per invocation. `<repo>` is a GitHub `owner/name`.
  - The local checkout comes from `runs.json` (matched by origin remote) or `~/.config/brewery/config.json` `repos.<owner/name>`.
  - If there is no checkout, it clones to a temp worktree.
  - The `cellar` skill takes the same argument (`/cellar owner/name`), so it can also be run by hand.
- Collects, since that repo's last run (stamp per repo in `~/.local/state/brewery/cellar.json`):
  - that repo's brewery runs: journals, `ci/*.json`, Roast reasons, human answers
  - `gh` failed workflow runs and merged PRs for that repo, including non-brewery PRs
- Runs the `cellar` skill (`dot_claude/skills/cellar/SKILL.md`) in a worktree:
  cluster by signature → learnings → promote (≥2 recurrences or 1 human correction) → retire → open a PR.
  Mechanical rules become checks, not prose.
- The repo's `.brewery.json` `learn: off|local|shared`:
  - `off` exits early.
  - Only `shared` also opens a PR to the brewery skills with generic edits.
  - Flourish repos default to `local`.
- Sends an ntfy summary and appends to `cellar.log`.
- Verify:
  - a flow test with a fixture index of 2 runs that share a CI signature produces one rule proposal PR (fake `gh`)
  - `--dry-run` prints the plan
  - an unknown repo exits non-zero with a clear message

### 8. Scheduling (user-owned)
- Done: README section with a cron example and the exit codes.
- No unit ships with this work. The README documents the call (`brewery cellar <owner/name>`, one line per repo)
  and the exit codes, so it can be wired into cron or a timer on any host.
- `cellar` is safe to run concurrently for different repos and is a no-op when nothing is new.

### 9. Retire the FD system
- Done: the index was empty, and no `/fd-*` commands existed in the repo or `~/.claude`.
- Remove `docs/features/`, the `/fd-*` commands and the FD section of `CLAUDE.md`.

### 10. Split out the brewery repo (after tasks 1–9 are stable)
- `git filter-repo` `brewery/` + the stage skills + `terreno-shared` + `cellar` into the brewery repo, and add `bin/install` (the zerg pattern).
- Leave a pointer in dotfiles `CLAUDE.md`.

