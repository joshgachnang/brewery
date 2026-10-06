# Subagent briefing

Fresh reviewers and verifiers start with no parent memory. Asking each child to
rediscover the repository (full-branch diff, skill catalog, every lifecycle
reference) routinely costs 100k+ tokens **per child**. The parent reconstructs
once and hands over a task-scoped briefing.

## Parent prepares one briefing

Include only:

- Current task id and the in-scope acceptance criteria, quoted
- `git diff --stat` and `git diff --name-only` for this slice
- The patch for those paths, not every file on the branch
- Named commands the child may run
- The one question the child must answer
- The output format to return

Do not tell the child to read the skill catalog or reconstruct independently.

## Child rules

1. Treat the briefing as the working set. Do not run a full-branch `git diff`.
2. Do not inspect the skill catalog or load lifecycle references the parent did
   not name.
3. Do not spawn nested general-purpose reviewers.
4. Read a file only to verify a finding or to run a named command.
5. Return the requested format. No transcripts and no restated rules.

## Roast

Roast is criterion → evidence. It is not a second independent-review pair.

- Prefer running named checks in the Roast invocation itself.
- Spawn at most one specialized UI/runtime verifier, and only when this task's
  briefing lists UI/runtime files.
- Do not spawn two unconstrained reviewers that each rediscover the repo.
- Do not spawn a conventions reviewer during Roast. Pick and Brew own that axis.

## Pick and Brew

When the harness supports fresh reviewers, pass the **same** briefing to each
axis. Two bounded children beat two unbounded clones.
