# Pick–Roast inner loop

Pick and Roast run as one automated inner loop until the approved task list is done.
The outer loop still owns Grow, Brew, Taste, persistence, Taste `PENDING` reinvocation,
and escalation. Taste waits in-process for product CI on the current head. The outer
loop does not wait between Pick and Roast, and it does not wait for a human to reinvoke
the next frontier task.

```text
Grow PASS
    → Pick (one unblocked task)
    → Roast (that task only)
         FAIL → Pick (same task, exact evidence)
         PASS + remaining unblocked tasks → Pick (next frontier task)
         PASS + no remaining unblocked tasks → Brew
Any BLOCKED → emit and exit to the named gate
```

## Bounds

The inner loop is bounded by the approved task graph, not by CI or wall-clock:

- One Pick implements exactly one current unblocked task.
- Roast proves that task before any later task starts.
- Do not start the next task until Roast PASS.
- Roast FAIL retries the same task with a new hypothesis; do not repeat a failed
  approach without new evidence.
- Exhausted retries, human/environment/access/external gates, or missing mandatory
  verifiers emit `FAIL` or `BLOCKED` and **exit**. The inner loop does not invent scope.
- Terminal inner-loop `PASS` requires every in-scope task to have a Roast `PASS` on the
  recorded head. Only then is `next: brew`.

Do not pick every task first and roast once at the end. Do not roast the whole IP after
the first Pick. Do not run independent frontier tasks in parallel inside this loop.

## Who executes whom

Invoking **Pick** enters this loop. Invoking **Roast** proves the current task only.
Roast never invokes Pick. Pick owns the inner loop. Exactly one driver continues after
each current-task Roast — that driver is always Pick. Do not let a parent Pick and a
Roast subagent both start the next task. A fresh Roast subagent has no conversational
"who invoked me" signal; prove-only Roast is the durable driver.

- After Pick records a completed slice, **invoke Roast to prove that task only**. Prefer
  a fresh context or subagent when the harness allows. Pass a
  [task-scoped briefing](subagent-briefing.md): this task's criteria, file list, and
  patch. Do not ask Roast or its children to rediscover the skill catalog or diff the
  whole branch. Roast must not spawn two unconstrained reviewers. If a fresh context is
  unavailable, execute Roast from durable artifacts only and ignore Pick's completion
  claims.
- Roast proves, records, and **returns**. It does not reconstruct Pick, does not invoke
  Pick, and does not start the next task. `PASS` with remaining tasks emits `next: pick`.
  `PASS` with none remaining emits `next: brew`. `FAIL` emits `next: pick`.
- When Pick invoked Roast, returning to Pick is enough. Pick then continues: Reconstruct
  the next frontier task, including architecture docs and supporting skills for that
  slice, or emit `next: brew` when none remain.
- When Roast is the entry skill, emit `next: pick` or `next: brew`. The caller (human or
  outer loop) runs Pick. Roast still never invokes Pick.
- After Roast `FAIL`, return evidence to the parent Pick, or emit `next: pick` with the
  exact `need` / `want` / `got` / `ev` evidence when Roast is the entry.
- Pick never skips Roast. Roast never implements the next slice itself.

Each cycle writes execution state (`task`, `attempt`, `last`, `tried`, `next`) before
continuing. The invocation emits one terminal stage result: the last cycle that stops
the loop. Intermediate cycle results live in execution state, not as extra human-facing
YAML dumps.

## Commits and pushes

Every commit a harness pushes starts a full CI run, so commits track proven behavior,
not loop bookkeeping:

- One behavior-scoped commit per task, made after that task's Roast `PASS`. It carries
  the code, tests, docs, and task-file mark together.
- Roast-driven fixes amend or squash into the task's unpushed commit. Do not add
  "harden", "strengthen", "prove", or "mark roasted" follow-up commits.
- Progress lives in execution state (`.terreno/pipeline/<slug>.json`), which is
  git-ignored. Do not commit task-file checkbox edits on their own.
- Pick and Roast do not push. Brew pushes once after the whole list has Roast `PASS`.
  Taste pushes at most once per reaction.
- Do not start the next task while product CI on the pushed head reports a
  branch-caused failure. Fix it first. Never wait on pending CI, and record
  failures the branch did not cause for Taste instead of blocking on them.

## Independence

Roast remains the authoritative verifier. Pick's internal reviews are not proof. Roast
reconstructs the head and artifacts independently, maps in-scope criteria for **the
current task**, and classifies each with evidence. It does not fix implementation
defects.

When Roast runs in-process after Pick, it still must not trust conversational memory of
the implementation. Fresh context is preferred, not optional when the harness can spawn
one.

## Entry and exit

| Entry | Behavior |
| --- | --- |
| Grow `PASS` / human invokes Pick | Start at the next unblocked incomplete task |
| Human invokes Roast after a Pick cycle | Prove the current task, emit `next: pick` or `next: brew`, return |
| Roast `FAIL` from a prior invocation | Pick retries that task, then Roast, then continue |

| Stop | `next` |
| --- | --- |
| All in-scope tasks have Roast `PASS` | `brew` |
| Pick or Roast objective failure after focused retry | `pick` or `roast` as named by evidence, and **exit** when the invocation cannot continue safely |
| Unresolved gate | `null` (`BLOCKED`) |

Brew preconditions require this terminal Roast `PASS` across the in-scope task list, not
a Roast of only the last slice while earlier slices are unproven.
