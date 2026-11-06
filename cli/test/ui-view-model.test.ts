import { describe, expect, test } from "bun:test";
import type { Stage } from "../src/config.ts";
import type { BreweryEvent } from "../src/events.ts";
import { newState, type Phase, type RunState } from "../src/state.ts";
import { buildRunView } from "../src/ui/view.ts";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const ROUTES = { distill: ["claude"], cut: ["claude"], test: ["claude"], pick: ["codex"], roast: ["claude"], review: ["claude"], brew: ["claude"], taste: ["claude"], compound: ["claude"], cellar: ["claude"], approve: ["claude"], calibrate: ["claude"] } as Record<Stage, string[]>;

const state = (phase: Phase, extra: Partial<RunState> = {}): RunState => ({
  ...newState({ slug: "demo", repo: "/tmp/demo", ip: "docs/plans/demo.md", base: "master", phase }),
  ...extra,
});

// Events on disk carry a timestamp `t` beside the typed fields.
let tick = 0;
const ev = (event: BreweryEvent): BreweryEvent => ({ t: new Date(Date.UTC(2026, 10, 5, 11, 0, tick++)).toISOString(), ...event } as unknown as BreweryEvent);
const start = (seq: number, stage: string, agent: string, task?: string): BreweryEvent => ev({ kind: "step.start", seq, stage, agent, ...(task ? { task } : {}) });
const end = (seq: number, status: string): BreweryEvent => ev({ kind: "step.end", seq, status, action: "next", seconds: 5 });

const view = (s: RunState, events: BreweryEvent[], opts: { phi?: boolean; routes?: Record<Stage, string[]> } = {}) =>
  buildRunView({ state: s, events, configuredRoutes: opts.routes ?? ROUTES, phi: opts.phi ?? false, now: NOW } as never);

const pipe = (v: { pipeline: { status: string }[] }): string[] => v.pipeline.map((p) => p.status);

describe("buildRunView", () => {
  test("pipeline lists the five stages in order", () => {
    expect(view(state("build"), [start(1, "distill", "claude"), start(2, "cut", "claude")]).pipeline.map((p) => p.stage)).toEqual(["distill", "cut", "signoff", "barrel", "finish"]);
  });

  test("build phase with T1 passed and T2 running has barrel active and T2's card active", () => {
    const s = state("build", {
      seq: 3,
      tasks: { T1: { status: "passed", attempts: 1 }, T2: { status: "running", attempts: 1 } },
    });
    const events = [start(1, "distill", "claude"), end(1, "PASS"), start(2, "cut", "claude"), end(2, "PASS"), start(3, "pick", "codex", "T2")];
    const v = view(s, events);
    expect(pipe(v)).toEqual(["done", "done", "done", "active", "todo"]);
    expect(v.active.map((c) => [c.seq, c.stage, c.task, c.status])).toEqual([[3, "pick", "T2", "running"]]);
    expect(v.tasks.map((t) => [t.id, t.status])).toEqual([["T1", "passed"], ["T2", "running"]]);
  });

  test("two roast starts with different agents and no ends are two active cards", () => {
    const v = view(state("review"), [start(1, "roast", "claude"), start(2, "roast", "codex")]);
    expect(v.active).toHaveLength(2);
    expect(v.active.map((c) => c.agent).sort()).toEqual(["claude", "codex"]);
    expect(v.steps).toHaveLength(2);
  });

  test("a finished step is in steps but not active, and carries its status", () => {
    const v = view(state("build"), [start(1, "pick", "codex", "T1"), end(1, "PASS")]);
    expect(v.active).toEqual([]);
    expect(v.steps[0]?.status).toBe("PASS");
  });

  test("a card keeps only the last 20 narration lines, in order", () => {
    const events: BreweryEvent[] = [start(4, "pick", "codex", "T1")];
    for (let i = 1; i <= 30; i++) events.push(ev({ kind: "narration", seq: 4, text: `line ${i}` }));
    const card = view(state("build"), events).steps.find((c) => c.seq === 4);
    expect(card?.narration).toHaveLength(20);
    expect(card?.narration[0]).toBe("line 11");
    expect(card?.narration[19]).toBe("line 30");
  });

  test("a retried pick gives the task's pick lane two cards, the first FAIL", () => {
    const events = [start(1, "pick", "codex", "T2"), end(1, "FAIL"), start(2, "pick", "codex", "T2")];
    const task = view(state("build", { tasks: { T2: { status: "running", attempts: 2 } } }), events).tasks.find((t) => t.id === "T2");
    expect(task?.lanes.pick.map((c) => [c.seq, c.status])).toEqual([[1, "FAIL"], [2, "running"]]);
    expect(task?.lanes.test).toEqual([]);
    expect(task?.lanes.roast).toEqual([]);
    expect(task?.attempts).toBe(2);
  });

  test("a waiting gate makes barrel waiting and copies the message and asks", () => {
    const asks = [{ q: "Ship it?", rec: "yes", opts: ["yes", "no"] }];
    const s = state("build", { waiting: { kind: "gate", asks, message: "Need a decision", since: "2026-11-05T11:00:00.000Z" } });
    const v = view(s, [start(1, "distill", "claude"), start(2, "cut", "claude")]);
    expect(pipe(v)).toEqual(["done", "done", "done", "waiting", "todo"]);
    expect(v.waiting?.message).toBe("Need a decision");
    expect(v.waiting?.asks).toEqual(asks);
    expect(v.waiting?.kind).toBe("gate");
  });

  test("a waiter is live only while its heartbeat is under 15 seconds old", () => {
    const waiting = (heartbeat?: string) => ({ kind: "gate" as const, asks: [], message: "m", since: "2026-11-05T11:00:00.000Z", ...(heartbeat ? { heartbeat } : {}) });
    expect(view(state("build", { waiting: waiting("2026-11-05T11:59:55.000Z") }), []).waiting?.live).toBe(true);
    expect(view(state("build", { waiting: waiting("2026-11-05T11:59:30.000Z") }), []).waiting?.live).toBe(false);
    expect(view(state("build", { waiting: waiting() }), []).waiting?.live).toBe(false);
  });

  test("no waiting state leaves waiting absent", () => {
    expect(view(state("build"), []).waiting).toBeUndefined();
  });

  test("usage events sum into the totals", () => {
    const events = [
      start(1, "pick", "codex", "T1"),
      ev({ kind: "usage", seq: 1, inputTokens: 100, outputTokens: 10, costUsd: 0.01 }),
      start(2, "roast", "claude", "T1"),
      ev({ kind: "usage", seq: 2, inputTokens: 200, outputTokens: 20, costUsd: 0.02 }),
    ];
    const v = view(state("build"), events);
    expect(v.totals.inputTokens).toBe(300);
    expect(v.totals.outputTokens).toBe(30);
    expect(v.totals.costUsd).toBeCloseTo(0.03, 10);
    expect(v.steps.find((c) => c.seq === 1)?.usage).toMatchObject({ inputTokens: 100, outputTokens: 10 });
  });

  test("with no usage events the token and cost fields are absent, not 0", () => {
    const v = view(state("build"), [start(1, "pick", "codex", "T1")]);
    expect("costUsd" in v.totals).toBe(false);
    expect("inputTokens" in v.totals).toBe(false);
    expect("outputTokens" in v.totals).toBe(false);
    expect(v.steps[0]?.usage).toBeUndefined();
  });

  test("a handoff event lists in handoffs", () => {
    const v = view(state("build"), [ev({ kind: "handoff", from: 3, to: 5 })]);
    expect(v.handoffs).toEqual([{ from: 3, to: 5 }]);
  });

  test("agents seen in the run win over the configured route; unseen stages report config", () => {
    const v = view(state("build"), [start(1, "pick", "claude", "T1")]);
    expect(v.routes.pick).toEqual({ agents: ["claude"], from: "run" });
    expect(v.routes.roast).toEqual({ agents: ["claude"], from: "config" });
    expect(v.routes.cut.from).toBe("config");
  });

  test("a stage run by two agents in the run lists both", () => {
    const v = view(state("review"), [start(1, "roast", "claude"), start(2, "roast", "codex")]);
    expect(v.routes.roast.from).toBe("run");
    expect([...v.routes.roast.agents].sort()).toEqual(["claude", "codex"]);
  });

  test("a phi run withholds narration, actions, the waiting message, and reduces asks to a count", () => {
    const asks = [{ q: "secret question", rec: "a" }, { q: "another", rec: "b" }];
    const s = state("build", { waiting: { kind: "gate", asks, message: "patient Jane Doe", since: "2026-11-05T11:00:00.000Z" } });
    const events = [start(1, "pick", "codex", "T1"), ev({ kind: "narration", seq: 1, text: "Reading jane.csv" }), end(1, "PASS")];
    const v = view(s, events, { phi: true });
    for (const card of v.steps) {
      expect(card.narration).toEqual([]);
      expect(card.action).toBeUndefined();
    }
    for (const lane of v.tasks.flatMap((t) => Object.values(t.lanes))) {
      for (const card of lane) {
        expect(card.narration).toEqual([]);
        expect(card.action).toBeUndefined();
      }
    }
    expect(v.waiting?.message).toBe("(withheld: phi)");
    expect(v.waiting?.asks).toBe(2);
    const json = JSON.stringify(v);
    expect(json).not.toContain("Jane");
    expect(json).not.toContain("jane.csv");
    expect(json).not.toContain("secret question");
  });

  test("a non-phi run keeps the step's action", () => {
    const v = view(state("build"), [start(1, "pick", "codex", "T1"), end(1, "PASS")]);
    expect(v.steps[0]?.action).toBe("next");
  });

  test("phase done has every stage done and nothing active", () => {
    const v = view(state("done"), [start(1, "distill", "claude"), start(2, "cut", "claude"), end(1, "PASS"), end(2, "PASS")]);
    expect(pipe(v)).toEqual(["done", "done", "done", "done", "done"]);
    expect(v.active).toEqual([]);
  });

  test("review phase with no distill or cut history skips the first three stages", () => {
    const v = view(state("review"), [start(1, "pick", "codex", "T1"), end(1, "PASS")]);
    expect(pipe(v)).toEqual(["skipped", "skipped", "skipped", "active", "todo"]);
  });

  test("signoff phase is done, done, waiting, todo, todo", () => {
    const v = view(state("signoff"), [start(1, "distill", "claude"), end(1, "PASS"), start(2, "cut", "claude"), end(2, "PASS")]);
    expect(pipe(v)).toEqual(["done", "done", "waiting", "todo", "todo"]);
  });

  test("distill phase is active, todo, todo, todo, todo; once cut starts it is done, active, todo...", () => {
    expect(pipe(view(state("distill"), [start(1, "distill", "claude")]))).toEqual(["active", "todo", "todo", "todo", "todo"]);
    expect(pipe(view(state("distill"), [start(1, "distill", "claude"), end(1, "PASS"), start(2, "cut", "claude")]))).toEqual(["done", "active", "todo", "todo", "todo"]);
  });

  test.each(["approved", "integrate"] as const)("%s phase makes barrel active", (phase) => {
    expect(pipe(view(state(phase), [start(1, "distill", "claude"), start(2, "cut", "claude")]))).toEqual(["done", "done", "done", "active", "todo"]);
  });

  test.each(["brew", "finish"] as const)("%s phase makes finish active", (phase) => {
    expect(pipe(view(state(phase), [start(1, "distill", "claude"), start(2, "cut", "claude")]))).toEqual(["done", "done", "done", "done", "active"]);
  });

  test("pr and ci events produce pr", () => {
    const v = view(state("finish"), [ev({ kind: "pr", number: 42, url: "https://example.test/pr/42" }), ev({ kind: "ci", state: "pass" })]);
    expect(v.pr?.number).toBe(42);
    expect(v.pr?.url).toBe("https://example.test/pr/42");
    expect(v.pr?.ci).toBe("pass");
  });

  test("no pr event leaves pr absent", () => {
    expect(view(state("build"), []).pr).toBeUndefined();
  });

  test("empty events build a valid view from state alone", () => {
    const s = state("build", { tasks: { T1: { status: "todo", attempts: 0 } } });
    const v = view(s, []);
    expect(v.active).toEqual([]);
    expect(v.steps).toEqual([]);
    expect(v.handoffs).toEqual([]);
    expect(v.waiting).toBeUndefined();
    expect(v.tasks).toHaveLength(1);
    expect(v.tasks[0]?.lanes).toEqual({ test: [], pick: [], roast: [] });
    expect(v.pipeline).toHaveLength(5);
    expect(v.routes.pick).toEqual({ agents: ["codex"], from: "config" });
  });
});

describe("usage and handoff event kinds", () => {
  test("BreweryEvent accepts usage and handoff members", () => {
    const usage: BreweryEvent = { kind: "usage", seq: 1, inputTokens: 1, outputTokens: 2 };
    const full: BreweryEvent = { kind: "usage", seq: 1, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, costUsd: 0.5 };
    const handoff: BreweryEvent = { kind: "handoff", from: 1, to: 2 };
    expect([usage.kind, full.kind, handoff.kind]).toEqual(["usage", "usage", "handoff"]);
  });
});
