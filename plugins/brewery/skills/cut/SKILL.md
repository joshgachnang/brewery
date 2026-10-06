---
name: cut
description: Attack an implementation plan (IP) from the requester's side. A fresh subagent that sees only what the human actually said, plus the IP, hunts for places the plan drifts from the request, assumes answers the human would reject, or cannot be executed or proven. Reports findings only; the calling skill (usually `distill`) fixes them. Use at the end of distill, or standalone on any IP before sign-off.
---

# Cut — attack the IP with the human's eyes

A distiller cuts the heads and tails from a run and keeps the heart. Cut does the same to
an IP. The agent that wrote the plan cannot see its own drift, because its research and
reasoning fill the gaps. The attacker gets only what the human said, so every gap shows.

Cut never edits the IP. It returns findings, and the caller fixes them.

## Run it with brewery

`brewery cut <ip> --request "<what the human said>"` runs this as separate agent processes (Claude, Codex, or local models via
litellm). It fans the attack out across every agent routed to `cut`, each in a
clean worktree of HEAD. Source: `tools/brewery/`. Use this skill directly for an
interactive, single-session run.

## Build the user-context packet

Collect, verbatim:

1. The original request: the human's message, ticket, or spec text, plus any linked
   material the human supplied.
2. Every reply the human gave: chat answers, the "Prior human answers" preamble, and
   answers pasted from Slack, text, or email.
3. The IP file path.

Leave out the planning agent's research notes, execution state, transcript, reasoning,
and summaries of what the human "meant". Paraphrase is the thing under attack. When
invoked standalone with no transcript, use the ticket or PR the IP cites and the IP's
Decisions table as the human's words, and say so in the report.

## Launch the attacker

Spawn one **fresh** subagent (`general-purpose`, never `fork`, which inherits the
planner's context). Pass the packet and this brief:

> You are reviewing an implementation plan on behalf of the person who asked for it. You
> have what they said and the plan. Assume the plan is wrong somewhere and find where.
> You may read the repository files the IP cites, to check a claim it makes about the
> code. Do not read `.terreno/`, planning transcripts, or anything else about how the
> plan was made.
>
> Attack on these axes:
>
> 1. **Fidelity.** Something they asked for that is missing, weakened, or deferred.
>    Something in the task list they did not ask for (belongs in Expansions).
> 2. **Assumed answers.** Open-question recommendations or Assumptions that conflict
>    with what they said, or that they would likely reject. Assumptions stated as facts.
> 3. **Mis-triage.** A deferrable question that is actually fundamental: a wrong guess
>    would change the destination, rewrite most tasks, or be irreversible or unsafe.
> 4. **Proof.** Acceptance criteria that are not observable or have no real
>    verification method.
> 5. **Executability.** A task a fresh engineer could not start without guessing:
>    missing seams, wrong order, hidden dependencies, claims about the code that are false.
> 6. **Risk.** PHI or security exposure, data migration, irreversible operations,
>    rollout and compatibility gaps the plan does not address.
> 7. **Decomposition.** Two tasks that write the same file with no dependency between
>    them; a task that is really two independently roast-able behaviours; a chain that
>    could be a fan-out. Check `Depends on:` against `Files:` and the proof for each task.
> 8. **Readability.** The brief does not make sense to someone who knows only the request.
>
> Return at most 12 findings, most severe first, as a markdown table:
> `ID | Severity (blocking / should-fix / nit) | Axis | Where in the IP | Attack | Evidence | Suggested fix`.
> Evidence is a quote of their words, a quote of the IP, or a file and line. A finding
> without evidence is dropped. "No findings" is a valid answer; do not invent any.

## Return

Hand the table back to the caller unchanged, prefixed with one line:
`Cut: <n> findings (<b> blocking) on <IP path>, context: <transcript | ticket+Decisions>`.

When invoked standalone by the human, print the table and offer to apply fixes through
`distill` step 10. Do not apply them yourself.
