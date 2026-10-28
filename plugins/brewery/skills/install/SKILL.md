---
name: install
description: >-
  Install and set up brewery end to end: check the prerequisites (git, an authenticated gh,
  Bun, and Claude Code or Codex), install the plugin in each agent tool present (Claude
  Code, Cursor, Codex), clone and link the `brewery` CLI, write the user config (your own
  ntfy topic, agent routing), and optionally onboard a repository (docs layout, testing and
  user guide conventions, `.brewery.json`, the approval agent, nightly cellar). Idempotent:
  checks before every change and reports what it did and what it skipped. Use when asked to
  install, set up, onboard, upgrade, or repair brewery, or to add brewery to a repo; not
  for running the pipeline (use `overview` to pick a skill).
---

# Install

Set brewery up so that the skills work in interactive sessions and the `brewery` CLI runs
the pipeline as separate agent processes. Every step checks first and changes nothing that
is already right. Ask before writing anything outside the current repository (`~/bin`,
`~/.config/brewery/`, a tool's settings, crontab), and never overwrite a file the human
edited: merge into it or show the diff and ask.

Input: optional words that narrow the job: `plugin`, `cli`, `repo` (onboard the current
repository only), `upgrade`, or a tool name (`claude`, `cursor`, `codex`). With none, do
steps 1–4 and offer 5–6.

## 1. Prerequisites

Check each and report the version or the gap. Stop only on a missing hard requirement.

| Tool | Check | Needed for |
| --- | --- | --- |
| git | `git --version` | everything |
| gh | `gh auth status` | finish, board, harvest, polish, tap, cellar, calibrate, approve (hard requirement for the CLI) |
| Bun | `~/.bun/bin/bun --version`, else `bun --version` | the CLI (`bin/install` looks in `~/.bun/bin`, then PATH) |
| Claude Code | `claude --version` | default agent for every stage |
| Codex | `codex --version` | second opinion on cut and review (optional; skipped with a note when absent) |
| Cursor agent | `agent --version` or `cursor-agent --version` | optional `cursor` profile |

At least one of `claude` or `codex` must be present. Missing Bun: point at
`curl -fsSL https://bun.sh/install | bash` and ask before running it.

## 2. Plugin (the skills, in interactive sessions)

For each tool found in step 1, check whether brewery is already installed, then install it.

**Claude Code.** Look for `brewery@brewery` in `claude plugin list`. If missing, run (or,
inside a session, use the slash forms `/plugin marketplace add joshgachnang/brewery` and
`/plugin install brewery@brewery`):

```bash
claude plugin marketplace add joshgachnang/brewery
claude plugin install brewery@brewery
```

Flags vary by version; check `claude plugin --help` before adding any.

Or, to declare it for every machine, merge this into `~/.claude/settings.json` (ask first):

```json
{
  "extraKnownMarketplaces": {
    "brewery": {"source": {"source": "github", "repo": "joshgachnang/brewery"}}
  },
  "enabledPlugins": {"brewery@brewery": true}
}
```

Skills are then `/brewery:distill`, `/brewery:barrel`, and so on. The subagents
`brewery:test-writer` and `brewery:test-runner` come with it.

**Codex.** `codex plugin list`; if brewery is missing:

```
codex plugin marketplace add joshgachnang/brewery
codex plugin add brewery@brewery
```

Skills show up as `brewery:distill`; mention one with `$` in the composer.

**Cursor.** It has no CLI install. Either a team marketplace (Dashboard → Plugins & MCPs →
Team Marketplaces → Add Marketplace → Import from Repo, paste
`https://github.com/joshgachnang/brewery`), or locally, once the checkout from step 3
exists: `ln -s <checkout>/plugins/brewery ~/.cursor/plugins/local/brewery`, then
Developer: Reload Window. Tell the human which; you cannot click the dashboard.

`upgrade`: Claude Code: `claude plugin marketplace update brewery`, then
`claude plugin update brewery@brewery`. Codex: `codex plugin marketplace upgrade brewery`.
A local Cursor link follows the checkout. If a subcommand is missing, run the tool's
`plugin --help` and use what it reports.

## 3. CLI

1. Checkout: use an existing one (`~/src/brewery`, or wherever `readlink -f ~/bin/brewery`
   points). Otherwise ask, then
   `git clone https://github.com/joshgachnang/brewery ~/src/brewery`. On `upgrade`,
   `git -C <checkout> pull --ff-only` (stop and report on a dirty tree or a diverged branch).
2. Run `<checkout>/bin/install`. It runs `bun install --frozen-lockfile` in `cli/` and links
   `~/bin/brewery` to `cli/src/cli.ts`. It is idempotent.
3. Check `~/bin` is on PATH (`command -v brewery`). If not, give the line for the human's
   shell rc file; do not edit it unasked.
4. Run `brewery agents`. A ✓ per installed agent and the stage routing is success. A ✗ on
   `local` is expected unless the human runs the litellm gateway it points at; a ✗ on
   `codex` only means cut and review run on Claude alone.

Run from the checkout, the CLI reads its skills from `plugins/brewery/skills`.
`BREWERY_SKILLS_DIR` overrides that; a binary built with `bun run compile` falls back to
`~/.claude/skills`.

## 4. User config

`~/.config/brewery/config.json` (or `$BREWERY_CONFIG`). Read it if it exists and merge;
create it only after the human agrees. Two defaults belong to brewery's author, so anyone
else must override them:

- `notify.ntfyUrl` defaults to the author's webhook. Ask for the human's own ntfy topic
  (`https://ntfy.sh/<random-topic>`, or a self-hosted server) and set it. Pings carry no
  content, but they should reach this human.
- The `local` agent points at the author's litellm gateway. Leave it unrouted, or ask for
  the human's own OpenAI-compatible endpoint and key variable.

A minimal file:

```json
{
  "notify": {"ntfyUrl": "https://ntfy.sh/<topic>"},
  "repos": {"owner/name": "/path/to/checkout"}
}
```

`repos` maps a repository to its checkout for `cellar` and `calibrate`; add the ones the
human names. Routing (`stages`, `agents`, `escalate`) and `limits` keep their defaults
unless asked; the reference is the CLI README's "Agents and routing" section.

## 5. Onboard a repository (optional, or `repo`)

From the target repository's root, on a branch (never commit to the default branch):

1. `brewery init-docs` adds `docs/{decisions,journal,learnings}/` and `RULES.md`, and points
   AGENTS.md or CLAUDE.md at them. Without the CLI, copy the templates from the checkout's
   `cli/templates/` (`rules.md` → `docs/learnings/RULES.md`, `learning.md` and `decision.md`
   → each directory's `TEMPLATE.md`) and add `docs/journal/.gitkeep`.
2. Conventions, in the repository's AGENTS.md or CLAUDE.md (whichever it already uses).
   Ask the human for each value; do not guess paths:

   ```markdown
   ## Testing conventions

   | Key | Value |
   | --- | --- |
   | E2E guide | docs/testing/e2e.md |
   | Regression suites | docs/regression/ |
   | Smoke command | <the repo's fastest end-to-end command> |

   ## User guide conventions

   | Key | Value |
   | --- | --- |
   | User guide | docs/user-guide/ |
   ```

   A repository with no end users writes `| User guide | none — <reason> |`.
3. `.brewery.json` only for what differs from the defaults: `worktreeSetup` (commands a
   fresh worktree needs before tests run, e.g. `["bun install"]`), `"phi": true` for a repo
   that handles health data (keeps CI log tails out of committed journals), `"learn":
   "off"` to skip compound.
4. Run state lives in `.terreno/`, which the CLI excludes from git through
   `.git/info/exclude` on its first run; nothing to commit for it.
5. Commit the onboarding on its branch and offer to open a PR.

## 6. Extras (optional, each only when asked)

- **Approval agent** (`brewery approve` in CI): needs a GitHub App and a CI job. Follow
  `docs/approve.md` in the checkout; the job templates are `templates/ci/`. Start in
  comment-only mode (`"approveLevels": []`).
- **Nightly learning:** one cron line per repository, e.g.
  `0 3 * * * brewery cellar owner/name >> ~/.local/state/brewery/cellar/cron.log 2>&1`.
  `brewery calibrate owner/name` runs the same way, weekly.
- **Daily sweeps:** `harvest` and `polish` run as skills on whatever timer the human has
  (a scheduled cloud agent, cron with `claude -p "/brewery:harvest owner/name"`, a zerg
  drone). Show the line; do not install it unasked.

## Report

End with one block: each step as `done`, `already set`, `skipped (<why>)`, or
`needs you (<exact action>)`, then the first command to try, usually
`brewery pour "<a small change>"` or `/brewery:overview`.
