# brewery

Agent skills as a plugin marketplace for Claude Code, Cursor, and Codex. One `skills/` tree per
plugin, with a manifest for each tool beside it.

| Plugin | Skills |
|---|---|
| `brewery` | `pour`, `distill`, `cut`, `barrel`, `finish`, `tap`, `compound`, `cellar`, `calibrate`, `board`, `harvest`, `polish`, plus `terreno-shared/` (the vendored terreno references they link to; not a skill) |

Copied from [shade](https://github.com/joshgachnang/shade)'s `.claude/skills` at `14e3a0c`.
Everything else in shade's `.claude/skills` stays there, including the unmodified `terreno-*`
lifecycle copies, which the upstream [terreno marketplace](https://github.com/FlourishHealth/terreno)
already serves to both tools.
`terreno-shared/VENDORED.md` explains how the brewery skills relate to upstream terreno.

`pour` is the one shot for small features: `brewery pour "<request>"` writes the IP and its
task list, cuts it, asks you only fundamental questions, approves a plan of at most six tasks
itself, then builds and finishes it like `barrel`. A bigger plan, or one with a fundamental
question, stops at sign-off and keeps going after your answer.

`barrel` builds every task tests-first: a separate step on Sonnet writes the task's tests from
its brief in the IP (seam, interface, worked cases, blast radius), brewery confirms they fail,
and only then does Pick implement against them. A test step or Pick that keeps failing is
retried on Opus. The `test-writer` and `test-runner` subagents in `plugins/brewery/agents/`
do the same inside an interactive session.

`tap` is barrel for bugs: give it issue numbers, tracker IDs, or a query ("the better-auth
issues from the last day") and it triages them, writes a short pre-approved fix IP, builds
each fix test-first through Pick and Roast, and runs `finish` on the PR. Issues that need a
product decision are reported instead of built.

`harvest` and `polish` are the daily sweeps. harvest triages every issue it has not seen,
labels it (`brewery:proposed`, then `fix-now`, `fix-later`, `wontfix`, `needs-info`,
`decide`), and sends one digest; only after the human answers does it close, comment, or
dispatch `fix-now` issues to `tap` workers in their own worktrees. polish finds your open PRs
in the current repo that have a conflict, red CI, or an unanswered bot thread, and runs
`finish` on each in its own worktree.

`compound` and `cellar` are the learning loop: compound records at most one learning after
work that struggled, and cellar is the nightly per-repo pass that promotes recurring
learnings to rules and checks. They came from dotfiles; the design is in
`docs/specs/2026-10-12-brewery-docs-and-learning-loop-design.md`.

## The CLI

`cli/` is the `brewery` command that runs distill → cut → sign-off → barrel → finish as
separate agent processes, plus the learning loop (`init-docs`, journals, `compound`, and the
nightly `brewery cellar <owner/name>`). It came from shade's `tools/brewery`; see
`cli/README.md`. `cd cli && bun install && bun test`.

## The board

`brewery board` (or `/brewery:board`) prints one repo's board from its IPs and run state:
in progress, blocked (waiting on you, unapproved, or behind unlanded `Depends on:` tasks),
next up (ready tasks, oldest plan first), and recent merges. `--json` for scripts and agents.

## Approving pull requests

`brewery approve <pr>` reviews a PR against a repo-owned rubric and posts one review as a
GitHub App, approving low-risk PRs when the repo allows it. CI templates are in
`templates/ci/`; the how-to and reference are in [`docs/approve.md`](docs/approve.md).

## Layout

```
.claude-plugin/marketplace.json     Claude Code marketplace
.cursor-plugin/marketplace.json     Cursor marketplace (pluginRoot: plugins)
.agents/plugins/marketplace.json    Codex marketplace
plugins/<plugin>/.claude-plugin/plugin.json
plugins/<plugin>/.cursor-plugin/plugin.json
plugins/<plugin>/.codex-plugin/plugin.json
plugins/<plugin>/skills/<skill>/SKILL.md
plugins/<plugin>/agents/<agent>.md     Claude Code and Cursor subagents (brewery:test-writer, brewery:test-runner)
```

Skills link to each other with relative paths (`../terreno-shared/…`), so a skill and the
files it links to stay in the same plugin.

## Install

**Claude Code**

```
/plugin marketplace add joshgachnang/brewery
/plugin install brewery@brewery
```

or declare it in a settings file:

```json
{
  "extraKnownMarketplaces": {
    "brewery": {"source": {"source": "github", "repo": "joshgachnang/brewery"}}
  },
  "enabledPlugins": {"brewery@brewery": true}
}
```

Skills are namespaced by plugin: `/brewery:distill`, `/brewery:barrel`.

**Cursor**

- Team marketplace: Dashboard → Plugins & MCPs → Team Marketplaces → Add Marketplace →
  Import from Repo, and paste `https://github.com/joshgachnang/brewery`.
- Local: copy or link a plugin directory into `~/.cursor/plugins/local/`, e.g.
  `ln -s ~/src/brewery/plugins/brewery ~/.cursor/plugins/local/brewery`, then
  Developer: Reload Window.

**Codex**

```
codex plugin marketplace add joshgachnang/brewery
codex plugin add brewery@brewery
```

Skills show up as `brewery:distill`, `brewery:harvest`, and so on; mention one with `$` in
the composer to invoke it.

## Checking a change

```bash
claude plugin validate .
claude plugin validate plugins/brewery
CODEX_HOME=$(mktemp -d ~/.codex-check.XXXX) sh -c \
  'codex plugin marketplace add . && codex plugin add brewery@brewery && codex plugin list'
```

Bump `version` in the plugin's three manifests (and the marketplaces) when a skill changes, so
installed copies update.
