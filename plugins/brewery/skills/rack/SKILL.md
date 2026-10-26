---
name: rack
description: Review what changed in terreno's planning skills since brewery last vendored them, and pull the useful parts into brewery. Diffs TerrenoLabs/terreno `plugins/terreno-planning/` from the SHA in `terreno-shared/VENDORED.md` to a target ref (default `master`, or a branch or SHA you name), sorts every change into copy, reapply, reflect, adopt, or skip, applies it, and records the new SHA with a reason for each skip. Use when asked to rack, resync, or vendor terreno, pull in upstream skill changes, or check whether brewery is behind terreno; not for changing terreno itself or for brewery-only skill edits.
---

# Rack — draw the clear beer off the sediment

Racking moves beer into a clean vessel and leaves the sediment behind. Rack does that for
terreno's lifecycle skills: it carries over what brewery's skills need and leaves behind
what brewery replaced, forked, or has no use for.

Read [`VENDORED.md`](../terreno-shared/VENDORED.md) first. Its table says which files are
verbatim copies, which are forks and what each fork changes, and which SHA they came from.

## Input

- Target ref: `master` by default, or a branch, tag, or SHA of TerrenoLabs/terreno. A
  local terreno checkout may stand in for the clone; then the target may be its working
  tree, recorded as the branch head plus "uncommitted".
- Optional scope: a list of upstream paths to limit the review to.

## Drive

1. **Fetch.** Clone or fetch TerrenoLabs/terreno into a temp directory (or use the local
   checkout). Resolve the recorded SHA from `VENDORED.md` and the target to full SHAs. The
   recorded SHA must be an ancestor of the target; if not, say so and diff the two trees
   anyway.
2. **List changes.** `git diff --stat <recorded>..<target> -- plugins/terreno-planning/`.
   brewery vendors from the Claude copy (`plugins/terreno-claude/`), generated from
   `terreno-planning`, so read the source diff there and copy files from the Claude copy.
   Also list new files under `references/` and `skills/`.
3. **Sort every changed path into exactly one bucket:**

   | Bucket | Which files | Action |
   | --- | --- | --- |
   | copy | `VENDORED.md` rows whose Changes is `none` | Copy the upstream file over brewery's, then check `git diff` shows only the upstream change |
   | reapply | forks: `barrel/stages/*.md`, `finish/taste.md`, `terreno-shared/testing.md`, `distill/references/distilling.md` | Read the upstream hunk, then make the same change by hand in brewery's fork, in brewery's voice. Keep every brewery change the Changes column lists, such as tests first, the test tiers, and `finish` owning the repeat loop |
   | reflect | contract changes brewery's own skills must carry: a new required IP section, a new gate, or a renamed term | Update `distill`, `cut`, `tap`, `pour`, `barrel`, `finish`, `harvest`, or `polish` where they write, attack, or act on that contract. Add a `cli/test/layout.test.ts` case for each new required phrase |
   | adopt | a new upstream reference or skill brewery's skills will link to | Vendor it into `terreno-shared/` and add a `VENDORED.md` row |
   | skip | anything else | Write one line saying why: brewery replaced it (Grow → `distill`), it is Terreno-app specific, or it is an operator tool such as a backfill skill that brewery does not run |

   Prefer skip when unsure, and name it in the report so the human can overrule it.
4. **Apply.** Work the buckets in order: copy, adopt, reapply, reflect. A reapply hunk
   that fights a brewery change is a judgment call: keep brewery's behavior, carry over
   the upstream intent, and say so in the report.
5. **Record.** Update `VENDORED.md`: the new SHA (or "branch `<name>` at `<sha>`, not yet
   on master" for a pre-merge target), the plugin version, a one-line summary of what this
   rack brought in, and any new or changed table rows. Bump the brewery plugin version in
   every manifest (`.claude-plugin`, `.cursor-plugin`, `.codex-plugin`, and the three
   marketplace files).
6. **Prove.** `cd cli && bun test && bun run typecheck`. For every `copy` row, diff the
   file against the upstream copy at the recorded SHA: it must be empty. Fix failures
   before reporting.
7. **Commit.** One commit on a fresh branch, subject like
   `Rack terreno <short sha>: <what came in>`. The body lists adopted and skipped items
   with their reasons. Do not push or open a PR unless the human asks.

## Report

- Recorded SHA → target SHA, and how many upstream files changed
- Each bucket with its paths: copied, adopted, reapplied (with any judgment calls),
  reflected (which brewery skills changed and why)
- Skipped items, one reason each
- Test results and the commit SHA

## Never

- overwrite a fork with the upstream file, or drop a change its Changes column lists
- vendor a skill brewery has its own version of (Grow, Pick-Roast loop, planning loop,
  taste sweep)
- edit terreno
- leave `VENDORED.md` naming a SHA the vendored files do not match
