---
name: compound
description: >-
  Record at most one learning from work that just struggled (failed attempts, CI fixes,
  review findings, human corrections) as docs/learnings/<category>/<slug>.md, so the next
  agent does not repeat it. Run by brewery at the end of a run, or by hand with /compound
  after a session that hit a non-obvious problem — including remote and web sessions that
  brewery never sees.
---

# Compound

Turn what went wrong into one durable learning, or decide nothing clears the bar. Most runs
should end with nothing written. A store full of noise gets ignored.

## Inputs

- **Under brewery:** the prompt lists the struggles (failed Pick/Roast attempts with their
  evidence, CI failures with the fixing commit, the human's corrections). Read the commits
  it names (`git show`, `git log <failed>..<fixed>`) to find the actual fix.
- **By hand:** the struggles are this session's: failed commands, CI runs that went red,
  approaches you abandoned, and anything the human corrected. Corrections are the strongest
  signal.

## The bar

Write a learning only when **a future agent reading the final code would still repeat the
mistake**. Skip:
- one-off typos, mistakes the code or a test now makes impossible
- flaky checks that passed on rerun (brewery tracks those separately)
- anything already covered by `docs/learnings/RULES.md` or an existing learning, unless that
  learning is wrong or incomplete, in which case update it

## Method

1. `grep -rl` the frontmatter in `docs/learnings/` (module, component, tags, symptoms) for
   the area. If one covers the same root cause, **update it** (add symptoms, sharpen the
   solution, add evidence) rather than writing a new file.
2. Otherwise copy `docs/learnings/TEMPLATE.md` to `docs/learnings/<category>/<slug>.md`.
   `category` is one of ci, testing, tooling, patterns, workflow. The slug names the problem,
   not the date.
3. Fill the frontmatter completely:
   - `title`: an instruction ("Run migrations before the API tests in CI"), not a story.
   - `symptoms`: the exact error lines someone would grep for.
   - `source`: ci, roast, review, or human.
   - `evidence`: run slug, PR, CI link, commit shas.
   - `retire_when`: the condition that makes it obsolete.
   - Leave `promoted_to` empty. `brewery cellar` promotes recurring learnings into rules,
     skills, or checks.
4. Body: Problem, Symptoms, What didn't work, Solution, Prevention. Short. Prevention says
   what check, test, or rule would have caught it.

## Limits

- At most one learning file per run. Touch nothing else: not `RULES.md`, not code.
- No PHI, customer data, secrets, or tokens. Describe data by shape ("a patient record with
  no carePod"), never by value. Quote error lines only after removing identifiers.
- Under brewery, report the path in the result's `learning` key (or null) and do not commit.
  By hand, commit it with the work it came from.
