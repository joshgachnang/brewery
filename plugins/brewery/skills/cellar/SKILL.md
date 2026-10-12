---
name: cellar
description: >-
  Nightly learning pass for one repo (`/cellar owner/name`, or `brewery cellar owner/name`
  on a timer). Reads what happened since the last pass (brewery run journals, failed CI
  runs, merged PRs from any session, local or remote) and turns recurring problems into
  learnings, capped rules in docs/learnings/RULES.md, and deterministic checks, delivered
  as one PR. Retires rules that stopped paying rent.
---

# Cellar

You maintain a repo's learned knowledge so the next agent makes fewer of the same mistakes.
Output is a small PR. A PR with nothing in it is fine; the bar matters more than volume.

## Inputs

- **Under brewery:** the prompt holds the evidence (journal paths, failed CI runs with
  scrubbed log tails, merged PRs). You are in a fresh worktree of the default branch.
- **By hand (`/cellar owner/name`):** gather it yourself since the last cellar PR
  (`gh pr list -R <name> --search "Record learnings in:title" --state all -L 1`):
  `git log --since … -- docs/journal`, `gh run list -R <name> --status failure --created ">=<date>"`,
  `gh run view <id> --log-failed`, `gh pr list -R <name> --state merged --search "merged:>=<date>"`.
  Work on a branch, then open the PR yourself.
- Always read: `docs/learnings/RULES.md`, the frontmatter of everything in `docs/learnings/`,
  and the journals listed. For a merged PR, `gh pr view <n> --comments` shows review
  corrections. Those are a strong signal, like a human's reply in a journal.

## Method

1. **Cluster** CI failures by signature: workflow + job + the first real error line (not
   the stack, not timestamps). Ignore runs on branches that were abandoned, and failures
   that passed on rerun at the same sha (flaky). Do count flakes: three or more on one
   check is worth a Proposal to quarantine or fix it.
2. **Match** each cluster, struggle, and correction against existing learnings (module,
   component, symptoms). Update a matching learning's `symptoms` and `evidence` rather than
   creating a duplicate. Write a new learning (copy `docs/learnings/TEMPLATE.md`) only when
   it clears the compound bar: a future agent reading the final code would still repeat it.
3. **Promote** up the ladder, and say which rung and why:
   - learning → **rule** when it has recurred (two or more pieces of evidence across runs or
     PRs) or the human corrected an agent about it once. A rule is one imperative line in
     RULES.md Active, with the learning path in parentheses. Set the learning's
     `promoted_to`.
   - rule → **check** when it is mechanical (formatting, lint, types, a missing env var, a
     forgotten migration, a test fixture rule). Prefer a lint rule, a test, a pre-push hook,
     or a CI step that makes the mistake impossible, then retire the prose rule.
4. **Retire** rules whose learning's `retire_when` now holds, that a check now enforces, or
   that no evidence has touched in 60 days and the code has moved on. Move them to Retired
   with the date and reason. Keep Active at 15 or fewer: merge overlapping rules first.
5. **Proposals** in RULES.md for anything that needs a human or real work: CI
   infrastructure, a flaky test that needs an owner, a process change.

## Limits

- At most 3 changes per pass: each new Active rule and each changed file outside the
  learning files counts. brewery refuses the whole PR over the limit. Pick the three with
  the most evidence; the rest can wait for the next pass.
- Cite evidence for every change: run slug, PR number, CI link, or learning path.
- Never touch `docs/journal/`, `docs/plans/`, `docs/decisions/`, or product code beyond a
  check. Don't fix the bugs you find; record them.
- No PHI, customer data, secrets, or tokens in anything you write. Describe data by shape.
  When learning mode is `local`, write nothing about this repo into shared skills. When it
  is `shared`, describe generic skill improvements as `proposals` in the result; don't
  edit skill files.
