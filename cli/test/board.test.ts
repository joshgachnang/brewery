// `brewery board`: which column each plan, task, run, and PR lands in.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildBoard, gatherBoard, renderBoard, type BoardInput } from "../src/board.ts";
import { newState, type RunState } from "../src/state.ts";
import { run, tempRepo } from "./helpers.ts";

const plan = (status: string, tasks: string): string => `# Plan

Orientation.

## Tasks

${tasks}

## Sign-off

Status: ${status}
`;

const GRAPH = `- [x] **T1** — Tracer
  - Depends on: none
- [ ] **T2** — Wide one
  - Depends on: T1
- [ ] **T3** — Wide two
  - Depends on: T1
- [ ] **T4** — Join
  - Depends on: T2, T3`;

const input = (over: Partial<BoardInput>): BoardInput => ({ repo: "/repo", plans: [], runs: [], openPrs: [], merges: [], ...over });

const runOn = (path: string, over: Partial<RunState>): RunState => ({
  ...newState({ slug: "feat", repo: "/repo", ip: `/repo/${path}`, base: "master", phase: "build" }),
  ...over,
});

describe("board", () => {
  test("an approved plan with no run lists ready tasks as next and the rest as blocked on deps", () => {
    const board = buildBoard(input({ plans: [{ path: "docs/plans/a.md", text: plan("approved 2026-10-20", GRAPH) }] }));
    expect(board.next.map((t) => t.id)).toEqual(["T2", "T3"]);
    expect(board.waitingTasks).toEqual([{ plan: "docs/plans/a.md", id: "T4", title: "Join", waitingOn: ["T2", "T3"] }]);
    expect(board.inProgress).toEqual([]);
  });

  test("a run's passed and running tasks count even before the main tree's IP is ticked", () => {
    const path = "docs/plans/a.md";
    const board = buildBoard(input({
      plans: [{ path, text: plan("approved 2026-10-20", GRAPH) }],
      runs: [runOn(path, { tasks: { T2: { status: "passed", attempts: 1 }, T3: { status: "running", attempts: 1 } }, pr: 9 })],
    }));
    expect(board.inProgress).toEqual([{ plan: path, title: "Plan", detail: "build, 2/4 tasks, running T3, PR #9" }]);
    expect(board.next).toEqual([]);
    expect(board.waitingTasks.map((t) => [t.id, t.waitingOn])).toEqual([["T4", ["T3"]]]);
  });

  test("a run waiting on the human and an unsigned plan are blocked", () => {
    const board = buildBoard(input({
      plans: [
        { path: "docs/plans/a.md", text: plan("approved 2026-10-20", GRAPH) },
        { path: "docs/plans/b.md", text: plan("awaiting sign-off", "- [ ] **T1** — Only") },
      ],
      runs: [runOn("docs/plans/a.md", { waiting: { kind: "gate", asks: [], message: "T2 failed roast three times\nmore", since: "2026-10-20T00:00:00Z", task: "T2" } })],
    }));
    expect(board.blocked.map((b) => b.detail)).toEqual([
      'waiting on you (gate T2): T2 failed roast three times — brewery answer feat "<reply>"',
      "not approved (Status: awaiting sign-off), 0/1 tasks",
    ]);
    expect(board.next).toEqual([]);
  });

  test("finished plans are counted, not listed; a finishing run stays in progress", () => {
    const done = plan("approved 2026-10-01", "- [x] **T1** — Only");
    const board = buildBoard(input({
      plans: [{ path: "docs/plans/old.md", text: done }, { path: "docs/plans/new.md", text: done }],
      runs: [runOn("docs/plans/new.md", { phase: "finish", pr: 12 })],
    }));
    expect(board.plans).toEqual({ open: 1, done: 1 });
    expect(board.inProgress.map((i) => i.detail)).toEqual(["finish, 1/1 tasks, PR #12"]);
  });

  test("open PRs no run owns show as in progress", () => {
    const board = buildBoard(input({
      plans: [{ path: "docs/plans/a.md", text: plan("approved 2026-10-20", GRAPH) }],
      runs: [runOn("docs/plans/a.md", { branch: "feat" })],
      openPrs: [{ number: 3, title: "Feat", branch: "feat", isDraft: false }, { number: 4, title: "Hand fix", branch: "fix-it", isDraft: true }],
    }));
    expect(board.inProgress.map((i) => i.title)).toEqual(["Plan", "PR #4 Hand fix"]);
    expect(renderBoard(board)).toContain("PR #4 Hand fix — draft, fix-it");
  });

  test("gathers plans and runs from the repo and falls back to git history for merges", async () => {
    const repo = tempRepo();
    mkdirSync(join(repo, "docs", "plans"), { recursive: true });
    writeFileSync(join(repo, "docs", "plans", "2026-10-20-a.md"), plan("approved 2026-10-20", GRAPH));
    run(repo, "git", "add", "-A");
    run(repo, "git", "commit", "-q", "-m", "Add the plan");
    const state = { ...newState({ slug: "a", repo, ip: join(repo, "docs", "plans", "2026-10-20-a.md"), base: "master", phase: "build" as const }), tasks: { T2: { status: "running" as const, attempts: 1 } } };
    mkdirSync(join(repo, ".terreno", "brewery", "a"), { recursive: true });
    writeFileSync(join(repo, ".terreno", "brewery", "a", "state.json"), JSON.stringify(state));

    const board = buildBoard(await gatherBoard(repo, { base: "master", planDirs: ["docs/plans"], merges: 5 }));
    expect(board.inProgress.map((i) => i.detail)).toEqual(["build, 1/4 tasks, running T2"]);
    expect(board.next.map((t) => t.id)).toEqual(["T3"]);
    expect(board.merges.map((m) => m.title)).toEqual(["Add the plan", "Initial commit"]);
  });
});
