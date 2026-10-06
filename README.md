# brewery

Agent skills as a plugin marketplace for both Claude Code and Cursor. One `skills/` tree per
plugin, with a manifest for each tool beside it.

| Plugin | Skills |
|---|---|
| `brewery` | `distill`, `cut`, `barrel`, `finish`, plus `terreno-shared/` (the vendored terreno references they link to; not a skill) |

Copied from [shade](https://github.com/joshgachnang/shade)'s `.claude/skills` at `14e3a0c`.
Everything else in shade's `.claude/skills` stays there, including the unmodified `terreno-*`
lifecycle copies, which the upstream [terreno marketplace](https://github.com/FlourishHealth/terreno)
already serves to both tools.
`terreno-shared/VENDORED.md` explains how the brewery skills relate to upstream terreno.

## Layout

```
.claude-plugin/marketplace.json     Claude Code marketplace
.cursor-plugin/marketplace.json     Cursor marketplace (pluginRoot: plugins)
plugins/<plugin>/.claude-plugin/plugin.json
plugins/<plugin>/.cursor-plugin/plugin.json
plugins/<plugin>/skills/<skill>/SKILL.md
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

## Checking a change

```bash
claude plugin validate .
claude plugin validate plugins/brewery
```

Bump `version` in the plugin's two manifests (and the marketplaces) when a skill changes, so
installed copies update.
