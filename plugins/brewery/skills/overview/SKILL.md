---
name: overview
description: >-
  Map of brewery: what each skill and `brewery` command does, the order the pipeline runs
  them in (distill → cut → sign-off → barrel → finish), the side loops (tap, harvest,
  polish, compound, cellar, approve, calibrate, board, rack, recipe), and which one fits the
  request in front of you. Use when asked what brewery is, how it works end to end, or
  which brewery skill or command to use; read-only, never starts a run.
---

# Overview

Read-only. Explain, or name the one skill or command that fits, with the exact invocation.
Do not start it unless asked.

## The pipeline

```text
request ─▶ distill ─▶ cut ─▶ sign-off ─▶ barrel ───────────────────────────────▶ finish ─▶ merge
           write IP   attack  human:      per task: test ▶ pick ▶ roast ▶ land     CI green,
           + tasks    it      "ok"        then integrate ▶ review ▶ brew (PR)      bots answered
```

- **IP** (implementation plan): `docs/plans/YYYY-MM-DD-<slug>.md`, a brief, decisions,
  tasks with `Depends on:` and a test brief each, plus `## E2E tests`, `## Regression
  cases`, `## User guide`, and `## Design` sections.
- **Pick** builds one task against tests a separate step wrote first; **Roast** is a fresh
  agent proving that task's acceptance criteria; **Brew** opens the PR; **Taste** fixes one
  red CI snapshot or bot thread. Before the push, barrel, tap, and pour check the branch
  against the approval agent's four bars (plan match, architecture, tests, evidence) per
  `barrel/references/approval-ready.md`, so the PR reaches `brewery approve` already passing. These stages are terreno's, vendored in `terreno-shared/`.
- `recipe` (optional) sits above the pipeline: it shapes a Linear project whose milestones
  each become one distill, pour, or tap request.
- With a Claude Design, recipe and distill add questions and drafts to the canvas at
  checkpoints and turn the human's canvas edits into plan changes; distill snapshots the
  artboards at sign-off (`docs/specs/<slug>/design/`) and barrel builds against the
  snapshot. See `distill/references/designing.md`.
- The human is asked only at sign-off and at gates (a task stuck after its attempts, review
  that will not converge, CI still red after three fix rounds).

## Pick one

| The human wants to… | Skill | CLI |
| --- | --- | --- |
| Shape a bigger idea into a Linear project | `recipe` | — (skill only) |
| Plan a feature for later | `distill` | `brewery distill "<request>"` |
| Check a plan against what was asked | `cut` | `brewery cut <ip>` |
| Build an approved plan to a green PR | `barrel` | `brewery barrel <slug>` |
| Plan and build a small feature in one go | `pour` | `brewery pour "<request>"` |
| Fix issues, bugs, or Sentry errors | `tap` | — (skill only) |
| Get one PR conflict-free and green | `finish` | `brewery finish [pr]` |
| Fix every broken PR they authored here | `polish` | — (skill only) |
| Triage the repo's open issues | `harvest` | — (skill only) |
| See what is in flight, blocked, next | `board` | `brewery board`, `brewery status` |
| Answer a waiting run | — | `brewery answer <slug> "<reply>"` |
| Record a learning after a hard session | `compound` | automatic at the end of a CLI run that struggled |
| Turn recurring problems into rules (nightly) | `cellar` | `brewery cellar <owner/name>` |
| Review a PR and approve the low-risk ones | — | `brewery approve <pr>` |
| Learn approval rules from human reviews | `calibrate` | `brewery calibrate <owner/name>` |
| Pull terreno's skill changes into brewery | `rack` | — (skill only) |
| Install or set up brewery, or onboard a repo | `install` | `bin/install`, `brewery init-docs` |
| Find the right one of these | `overview` (this skill) | `brewery help` |

## Skill or CLI

Every pipeline stage exists twice. The **skill** runs inside the current session, with
subagents for the independent parts (cut, test-writer, roast). The **CLI** runs each step
as its own `claude -p` / `codex exec` process, owns commits, CI waits, limits, and the
human loop, and exits 3 while it waits on the human. Prefer the CLI for anything that
should run unattended or survive a closed laptop; prefer the skill when the human is
present and wants to steer.

## Where things live

- Plans: `docs/plans/`; specs: `docs/specs/`.
- CLI run state: `.terreno/brewery/<slug>/` (git-excluded): `state.json`, `events.jsonl`,
  each step's prompt, log, and result under `steps/`.
- Learning: `docs/learnings/RULES.md` (≤15 active rules every step reads),
  `docs/learnings/<category>/<slug>.md`, `docs/journal/`, `docs/decisions/`.
- Config: `~/.config/brewery/config.json`, then `<repo>/.brewery.json`, then `--agents`.

## Replies at a gate

Sign-off: `ok` (accept every recommendation), `ok, 2b` (approve, but take option b on
question 2), `no: <why>`, or answers alone (applied, then asked again). Gates: `1a`,
`retry: <hint>`, `skip` (a task), `ship` (integration or review), `stop`.
Mid-run guidance without answering: `brewery note <slug> "<text>"`.
