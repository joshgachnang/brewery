---
name: calibrate
description: >-
  Turn what humans said in pull request reviews into approval rules the robot applies
  next time (`/calibrate owner/name`, or `brewery calibrate owner/name` on a timer or by
  hand with pasted notes). Reads human review comments, verdicts, and the approval agent's
  own verdicts since the last pass, and delivers one PR that edits the repo's approval
  rubric and path rules. Generic rules come back as proposals for brewery's default rubric.
---

# Calibrate

You make the approval agent review the way the humans on this repo review. Input is what
they actually said on pull requests; output is a small PR to the approval rubric
(`docs/approval-rubric.md` unless `.brewery.json` names another file) and, when a comment
is about where code lives, to the `pathRules` in `.brewery.json`. A PR with nothing in it
is fine. The bar is "a reviewer said this and would say it again", not "this sounds wise".

## Inputs

- **Under brewery:** the prompt holds the evidence: every PR with human review activity in
  the window, each with the human verdicts (APPROVED, CHANGES_REQUESTED), what the approval
  agent said about the same head when it reviewed it, every human comment with its file
  and line and diff hunk, and any notes the human pasted in by hand. You are in a fresh
  worktree of the default branch.
- **By hand (`/calibrate owner/name`):** gather it yourself:
  `gh pr list -R <name> --state all --search "updated:>=<date>"`, then per PR
  `gh api repos/<name>/pulls/<n>/reviews`, `gh api repos/<name>/pulls/<n>/comments`, and
  `gh api repos/<name>/issues/<n>/comments`. Work on a branch, then open the PR yourself.
- Always read the current rubric top to bottom first, and `.brewery.json`'s `approve`
  block. Half of what humans say is already there; the job is then to sharpen the
  wording or add the example, not to add a second line.

## Method

1. **Cluster** comments by what they ask for, not by PR: "add a test for the error path",
   "use the generated SDK", "this needs a changelog fragment", "why is this file in the
   diff". A pasted note counts as one comment with the human's weight. Ignore pure
   questions that were answered in the thread, praise, and anything about a one-off.
2. **Weigh** each cluster. Two or more humans, or one human twice, or one comment that
   came with CHANGES_REQUESTED, clears the bar. One mild comment does not, unless the
   pasted notes say it matters.
3. **Compare** with the approval agent's own verdict on the same PR where there is one.
   The agent said low and the human requested changes: find what the human saw and make
   the rubric name it. The agent said high and the human approved without a word: find
   which signal over-fired and soften it. These disagreements are the best evidence you
   have.
4. **Place** each rule in the rubric section it belongs to (Levels, a Dimension, the repo's
   architecture section, Security, Dependencies, Changelog and versioning, Plan
   expectations, Signals that move the level, Blocking findings). Write it as one line a
   reviewer can check against a diff, with the example the human gave. A rule about where
   files live or which paths are risky is a `pathRules` entry (floor, ceiling, never),
   not prose. A rule about who or what to skip is `skipAuthors` or `skipLabels`.
5. **Cite** the PR numbers and reviewer behind each change in the `changes` result list,
   and keep a one-line record in the rubric only when the example itself is the rule.
6. **Propose** lines that are true of any repository (not this codebase's names, packages,
   or people) as `proposals` in the result: lines ready to paste into brewery's default
   rubric. Do not edit brewery.

## Limits

- Change only the rubric, `.brewery.json`, and `docs/learnings/`. Anything else means no PR.
- At most 8 new rubric lines per pass. Prefer sharpening an existing line to adding one.
  Never delete a line a human did not contradict.
- Keep the rubric's shape: the level table, the four dimensions, the blocking list.
- No PHI, customer data, secrets, or tokens in anything you write. Quote a human's words
  only as far as the rule needs them; never quote code from a private repo into a proposal.
