---
name: pour
description: One shot for a small feature, from request to a merge-ready PR in one go. Writes its own IP and task list (distill), attacks it (cut), asks only fundamental questions, approves the plan itself when it is small and nothing fundamental is open, then builds every task tests-first through Pick and Roast, opens the PR (Brew) and loops `finish` until CI is green. Use when asked to pour, one-shot, or "just build" a small, well-understood feature; not for large or risky work (use `distill`, then `barrel`).
---

# Pour — request to green PR in one go

`distill` → `cut` → sign-off → `barrel` → `finish`, with sign-off skipped when it would add
nothing. Invoking pour is the human's approval in advance of any plan that is **small**
(at most 6 tasks) and has **no fundamental question** open. Anything else stops at sign-off
like `distill` does, and continues into the build once the human answers.

## Run it with brewery

`brewery pour "<request>"` runs this as separate agent processes (Claude, Codex, Cursor, or
local models via litellm). brewery, not the agent, decides whether the plan is small and has
no fundamental question (`limits.pourMaxTasks`, default 6), writes the approval, and enforces
the tests-first build: it checks red before Pick and green after. Source: `cli/` in
[brewery](https://github.com/joshgachnang/brewery). Prefer it over this skill when the
tool is available. Use this skill directly for an interactive, single-session run.

## Procedure

1. **Distill.** Follow the [`distill`](../distill/SKILL.md) skill steps 1–10: research,
   triage, shape, give every task its test brief, write the IP with its `## E2E tests`,
   `## Regression cases`, and `## User guide` sections (each rows or `None — <reason>`;
   `None — user guide off` when the repository opts out), cut it, fix it. Ask
   fundamental questions in chat when the human is here, in one round, at most four, with
   the structured question tool. The answers go into Decisions.
2. **Decide whether to stop.** Count the tasks and the fundamental questions still open.
   - More than 6 tasks, or any fundamental question unanswered → do distill step 11
     (sign-off) and stop. When the human approves, continue at step 4.
   - Otherwise → step 3.
3. **Approve.** Set the IP's Sign-off line to
   `Status: approved <date> (pour: <n> tasks, no fundamental questions, <k> recommendations assumed)`.
   Open questions stay in the IP with their recommendations, and the PR lists the ones
   the build relied on.
4. **Build.** Follow the [`barrel`](../barrel/SKILL.md) skill from Drive step 1: every task
   tests-first ([`test`](../barrel/stages/test.md) through the `brewery:test-writer`
   subagent, red confirmed), then Pick, then Roast in a fresh subagent; the integrated
   Roast; Brew; then `finish` until the PR is conflict-free with green CI.
5. **Report** as barrel does, and say that pour approved the plan itself, with the
   recommendations it assumed.

## Never

- approve a plan with a fundamental question open, or with more than 6 tasks
- approve a plan missing `## E2E tests`, `## Regression cases`, or `## User guide`
- build Expansions, merge the PR, or skip Roast
- stop between approval and a terminal `finish` result, except at a barrel human gate
