# distill and barrel plan e2e tests and manual regression cases

Sibling of terreno's IP `docs/implementationPlans/e2e-and-regression-testing.md` in
TerrenoLabs/terreno. That IP makes two sections required in every Terreno lifecycle
IP: `## E2E tests` and `## Regression cases`. It also teaches Pick, Roast, Brew and Taste
to write, run and record them. brewery's distill and cut write and attack IPs on their
own, and barrel runs forked Pick, Roast and Brew stages from a vendored copy. So until
this lands, bots driven by brewery never see the change. This plan brings distill, cut
and tap up to the contract, then resyncs the vendored files once the terreno PR merges.

## The idea

- distill writes both sections, and cut treats a missing section as blocking.
- tap's short fix IPs carry both sections, usually `None — <reason>` or one regression row.
- `terreno-shared/` vendors terreno's new `testing-plan.md`. barrel's forked stages pick up
  the terreno Pick, Roast and Brew changes, and `finish/taste.md` picks up the Taste change.
- A layout test proves that the skill text carries the contract, because `bun test` and
  `typecheck` otherwise never read skill text.

## The plan

| # | Task | Depends on | Lands in | Proves it |
| --- | --- | --- | --- | --- |
| T1 | distill, cut and tap require both sections, plus a layout test | none | distill, cut, tap, cli/test | `bun test` in `cli/` |
| T2 | Resync the vendored references and forked stages from terreno master | T1 | terreno-shared, barrel/stages, finish | `bun test` plus a per-row diff |
| T3 | Walk the distill regression case and record it | T2 | docs/regression/brewery.md | recorded run |

Tracer: T1.
E2E: the layout test in T1 (the CLI has no UI).
Regression: BREW-new-1 (below).
Precondition for T2: the terreno PR has merged, so the vendored SHA is a commit on
master.
Out of scope: changes to the brewery CLI parser (task-line format unchanged).

## E2E tests

| ID | Spec or flow | Layer | Proves | Written in |
| --- | --- | --- | --- | --- |
| E1 | `cli/test/layout.test.ts` new cases | unit | distill, cut and tap SKILL text carries `## E2E tests`, `## Regression cases`, and the cut blocking rule | T1 |

## Regression cases

Destination: `docs/regression/brewery.md`. T3 creates it.

| ID | Case | Steps | Expected | Platforms | Automated by | Added |
| --- | --- | --- | --- | --- | --- | --- |
| BREW-new-1 | Distill plans e2e and regression | In a repo that has `docs/testing/e2e.md`, run `distill` on "add a due date to todos". Then delete `## E2E tests` from the draft and run `cut` | The IP carries both sections. `cut` reports the deletion as blocking | Claude Code | E1 (text only) | e2e-and-regression-testing |

## Tasks

- [x] **T1** — distill, cut and tap require both sections, plus a layout test
  - Depends on: none
  - Files: plugins/brewery/skills/distill/SKILL.md, plugins/brewery/skills/distill/references/distilling.md, plugins/brewery/skills/cut/SKILL.md, plugins/brewery/skills/tap/references/triage.md, plugins/brewery/skills/terreno-shared/testing-plan.md, cli/test/layout.test.ts
  - Delivers:
    - distill step 8 (Specify proof) pairs each UI or cross-process criterion with a planned spec.
    - distill step 9 (Write) writes `## E2E tests` and `## Regression cases`, following `terreno-shared/testing-plan.md`, a copy of terreno's file from that PR's branch head.
    - The brief gains `E2E:` and `Regression:` lines.
    - cut adds three blocking rules: a missing section, a `None` with no reason, and a UI criterion with no planned spec.
    - tap's fix IP gains both sections.
    - The legacy rule applies: an IP approved earlier reads as `None — predates contract`.
  - Acceptance:
    - `bun test` and `bun run typecheck` pass in `cli/`.
    - New `layout.test.ts` cases fail when the distill, cut or tap text loses either heading or the blocking rule.

- [ ] **T2** — Resync vendored references and forked stages from terreno master
  - Depends on: T1
  - Files: plugins/brewery/skills/terreno-shared/*.md, plugins/brewery/skills/terreno-shared/*.json, plugins/brewery/skills/terreno-shared/VENDORED.md, plugins/brewery/skills/barrel/stages/pick.md, plugins/brewery/skills/barrel/stages/roast.md, plugins/brewery/skills/barrel/stages/brew.md, plugins/brewery/skills/finish/taste.md
  - Delivers:
    - Reapplies terreno's Pick, Roast, Brew and Taste changes, following VENDORED.md's Changes column, and re-copies `testing-plan.md` from master.
    - VENDORED.md records the merged master SHA and drops its stale "full copies" section (those directories do not exist).
    - `loop-engineering.md` is listed as an intentional omission.
  - Acceptance:
    - `bun test` and `bun run typecheck` pass in `cli/`.
    - For each VENDORED.md row with Changes "none", `diff` against the upstream file at the recorded SHA is empty. That covers `references/*` against `terreno-shared/*`, and `skills/2-pick/references/{testing,mocking}.md`.

- [ ] **T3** — Walk the distill regression case and record it
  - Depends on: T2
  - Files: docs/regression/brewery.md
  - Delivers: Creates the suite file in terreno's format, with BREW-001, then walks it once and stamps `Last full run`. The evidence goes in the PR description.
  - Acceptance: BREW-001 meets its Expected. If it fails, the task is `FAIL` and goes back to T1.

## Assumptions

- The task-line format and the CLI parser are unchanged, so this plan has no CLI code changes apart from the test.
- T2 waits for the terreno PR to merge. barrel stops at T2 with `BLOCKED (external)` until it does.

## Open questions (recommendation assumed)

| ID | Question | Recommendation | Why | If answered differently | Tasks affected |
| --- | --- | --- | --- | --- | --- |
| Q1 | Where does brewery keep its own regression suite? | `docs/regression/brewery.md`, the same spot as terreno | One convention everywhere | Skip a brewery suite and record the walk only in the PR | T3 |

## Expansions (follow up later)

None.

## Decisions

| ID | Question asked | Answer | What it changes |
| --- | --- | --- | --- |
| D1 | (asked in the terreno distill) Should this plan cover brewery too? | Both in this plan | This sibling IP exists and is signed off with terreno's |
| D2 | Approve both plans? | ok, approve (2026-10-23, chat) | Status approved; T2 still waits for the terreno PR to merge |

## Sign-off

Status: approved 2026-10-23
Cut: covered by the terreno IP's two cut rounds (findings F3–F6 of round 2 shaped this file)
