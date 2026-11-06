// T5: handoffs written by earlier steps are routed into the prompts of the steps that need them.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { barrel } from "../src/commands/barrel.ts";
import { finish } from "../src/commands/finish.ts";
import { runStage } from "../src/step.ts";
import { newState, runDir } from "../src/state.ts";
import type { PrSnapshot } from "../src/vcs.ts";
import { fakeCi, fakeSetup, IP, quietCtx, tempRepo } from "./helpers.ts";

setDefaultTimeout(30_000);

type Handoff = { did: string; learned: string[]; traps: string[]; files: string[] };
type Routed = { seq: number; stage: string; agent: string; status: string; handoff: Partial<Handoff> };
type HandoffsFor = (state: unknown, query: { stage: string; task?: string }) => Routed[];
const loadHandoffsFor = async (): Promise<HandoffsFor> => (await import("../src/handoff.ts")).handoffsFor as HandoffsFor;

const ho = (name: string): Handoff => ({ did: `did-${name}`, learned: [`learned-${name}`], traps: [`trap-${name}`], files: [`file-${name}.ts`] });
const pass = (name: string, action = "done"): Record<string, unknown> => ({ status: "PASS", action, handoff: ho(name) });
const HEADING = "## Handoffs from earlier steps";
const CLAIMS = "Claims from the implementer: verify them, do not trust them";

const events = (repo: string, slug: string): Record<string, unknown>[] =>
  readFileSync(join(runDir(repo, slug), "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

const prompts = (repo: string, slug: string, pattern: RegExp): string[] => {
  const dir = join(runDir(repo, slug), "steps");
  return readdirSync(dir).filter((f) => pattern.test(f) && f.endsWith(".prompt.md")).sort().map((f) => readFileSync(join(dir, f), "utf8"));
};

const seqsOf = (repo: string, slug: string, stage: string, task?: string): number[] =>
  events(repo, slug)
    .filter((e) => e.kind === "step.start" && e.stage === stage && (task === undefined || e.task === task))
    .map((e) => e.seq as number);

const handoffEvents = (repo: string, slug: string): { from: number; to: number }[] =>
  events(repo, slug).filter((e) => e.kind === "handoff").map((e) => ({ from: e.from as number, to: e.to as number }));

const direct = (plan: unknown[]) => {
  const repo = tempRepo();
  const { config } = fakeSetup(repo, plan);
  const ctx = quietCtx(newState({ slug: "greet", repo, ip: "", base: "master", phase: "build" }), config);
  return { repo, ctx };
};

// A prompt body whose "## Step:" line the fake agent matches on.
const step = (stage: string, task?: string): string => `## Step: ${stage}${task ? ` ${task}` : ""} marker\n`;

describe("barrel with test-first: handoffs between test, pick, and roast", () => {
  const RED = 'test "$(cat greeting.txt 2>/dev/null)" = hello\n';
  const oneTask = IP("approved 2026-09-27").replace("- [ ] **T2** — Add farewell file\n", "");
  const wroteTests = (name: string): Record<string, unknown> => ({ status: "PASS", action: "wrote the tests", tests: ["greeting.test.sh"], command: "sh greeting.test.sh", handoff: ho(name) });

  const setup = () => {
    const repo = tempRepo();
    mkdirSync(join(repo, "docs/plans"), { recursive: true });
    writeFileSync(join(repo, "docs/plans/greet.md"), oneTask);
    const { config } = fakeSetup(repo, [
      { match: "test T1", times: 1, write: { "greeting.test.sh": RED }, result: wroteTests("t1") },
      { match: "pick T1", times: 1, write: { "greeting.txt": "hello\n" }, result: pass("p1", "built") },
      { match: "roast T1", times: 1, result: { status: "FAIL", action: "add the empty-file case", retest: true, fail: [{ need: "empty file case", want: "a test", got: "none", ev: "greeting.test.sh" }], handoff: ho("r1") } },
      { match: "test T1", write: { "empty.test.sh": "test -s greeting.txt\n" }, result: { ...wroteTests("t2"), tests: ["greeting.test.sh", "empty.test.sh"], command: "sh greeting.test.sh && sh empty.test.sh" } },
      { match: "pick T1", write: { "extra.txt": "x\n" }, result: pass("p2", "extended") },
      { match: "roast T1", result: pass("r2", "proven") },
      { match: "roast INTEGRATE", result: pass("ri", "combined tree proven") },
      { match: "branch review", result: { status: "PASS", action: "reviewed", findings: [] } },
      { match: "brew", result: pass("b1", "opened") },
    ], { roast: ["beta"] });
    config.limits.testFirst = true;
    const state = newState({ slug: "greet", repo, ip: join(repo, "docs/plans/greet.md"), base: "master", phase: "approved" });
    return { repo, ctx: quietCtx(state, config) };
  };

  test("pick gets the test handoff, the retry pick gets earlier pick and roast handoffs oldest first, and the retest gets none", async () => {
    const { repo, ctx } = setup();
    // Pin the stage order so a routing mistake cannot hide behind a different run.
    expect(await barrel(ctx, fakeCi([{ sha: "a", mergeable: "MERGEABLE", mergeState: "CLEAN", checks: [{ name: "test", bucket: "pass" }] }]))).toBe("done");
    expect(events(repo, "greet").filter((e) => e.kind === "step.start" && e.task === "T1").map((e) => e.stage)).toEqual(["test", "pick", "roast", "test", "pick", "roast"]);

    const [pick1, pick2] = prompts(repo, "greet", /-pick-T1-/);
    expect(pick1).toContain(HEADING);
    expect(pick1).toContain("did-t1");
    expect(pick1).not.toContain("did-p1");

    // The retry pick sees the newest test, plus every earlier pick and roast, newest last.
    expect(pick2).toContain(HEADING);
    const order = ["did-p1", "did-r1", "did-t2"].map((marker) => pick2.indexOf(marker));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(pick2).not.toContain("did-t1");

    // Each delivery names its source (seq, stage, agent) and its verdict.
    const section = pick2.slice(pick2.indexOf(HEADING));
    expect(section).toContain("FAIL");
    expect(section).toContain("beta");
    expect(section).toContain("alpha");

    // A retest after a roast FAIL starts clean: no section at all.
    const [, retest] = prompts(repo, "greet", /-test-T1-/);
    expect(retest).not.toContain(HEADING);
    expect(retest).not.toContain("did-");
  });

  test("roast sees only the latest pick's files and traps, labelled as claims, never did or learned", async () => {
    const { repo, ctx } = setup();
    await barrel(ctx, fakeCi([{ sha: "a", mergeable: "MERGEABLE", mergeState: "CLEAN", checks: [{ name: "test", bucket: "pass" }] }]));
    const [roast1, roast2] = prompts(repo, "greet", /-roast-T1-/);
    expect(roast1).toContain(HEADING);
    expect(roast1).toContain(CLAIMS);
    expect(roast1).toContain("file-p1.ts");
    expect(roast1).toContain("trap-p1");
    expect(roast1).not.toContain("did-p1");
    expect(roast1).not.toContain("learned-p1");
    // The test step's handoff never reaches roast.
    expect(roast1).not.toContain("file-t1.ts");
    expect(roast1).not.toContain("trap-t1");

    // Second roast: only the latest pick (p2), not p1.
    expect(roast2).toContain("file-p2.ts");
    expect(roast2).not.toContain("file-p1.ts");
    expect(roast2).not.toContain("did-p2");
    expect(roast2).not.toContain("learned-p2");
  });

  test("integrated roast gets each task's pick files and traps and no did; brew gets the last passing pick's whole handoff", async () => {
    const { repo, ctx } = setup();
    await barrel(ctx, fakeCi([{ sha: "a", mergeable: "MERGEABLE", mergeState: "CLEAN", checks: [{ name: "test", bucket: "pass" }] }]));
    const [integrated] = prompts(repo, "greet", /-roast-INTEGRATE-/);
    expect(integrated).toContain(HEADING);
    expect(integrated).toContain("file-p2.ts");
    expect(integrated).toContain("trap-p2");
    expect(integrated).not.toContain("did-p2");
    expect(integrated).not.toContain("file-p1.ts");

    const [brew] = prompts(repo, "greet", /-brew-/);
    expect(brew).toContain(HEADING);
    expect(brew).toContain("did-p2");
    expect(brew).not.toContain("did-p1");
    expect(brew).not.toContain("did-r2");
  });

  test("every delivery emits a handoff event naming the source and the receiving seq", async () => {
    const { repo, ctx } = setup();
    await barrel(ctx, fakeCi([{ sha: "a", mergeable: "MERGEABLE", mergeState: "CLEAN", checks: [{ name: "test", bucket: "pass" }] }]));
    const [test1, test2] = seqsOf(repo, "greet", "test", "T1");
    const [pick1, pick2] = seqsOf(repo, "greet", "pick", "T1");
    const [roast1] = seqsOf(repo, "greet", "roast", "T1");
    const delivered = handoffEvents(repo, "greet");
    expect(delivered).toContainEqual({ from: test1, to: pick1 });
    expect(delivered).toContainEqual({ from: pick1, to: roast1 });
    expect(delivered).toContainEqual({ from: pick1, to: pick2 });
    expect(delivered).toContainEqual({ from: roast1, to: pick2 });
    expect(delivered).toContainEqual({ from: test2, to: pick2 });
    // The retest receives nothing.
    expect(delivered.filter((d) => d.to === test2)).toEqual([]);
  });
});

describe("runStage routing", () => {
  test("a source step with no handoff is skipped: no empty entry, no event for it", async () => {
    const { repo, ctx } = direct([
      { match: "pick T1", times: 1, result: pass("has") },
      { match: "pick T1", times: 1, result: { status: "FAIL", action: "no handoff here" } },
      { match: "pick T1", result: { status: "PASS", action: "retry" } },
    ]);
    for (let i = 0; i < 3; i += 1) await runStage(ctx, "pick", step("pick", "T1"), { task: "T1" });
    const [first, second, third] = prompts(repo, "greet", /-pick-T1-/);
    expect(first).not.toContain("## Handoffs");
    expect(second).toContain("did-has");
    expect(third.split(HEADING)).toHaveLength(2);
    expect(third).toContain("did-has");
    const [s1, s2, s3] = seqsOf(repo, "greet", "pick", "T1");
    const delivered = handoffEvents(repo, "greet");
    expect(delivered).toContainEqual({ from: s1, to: s3 });
    expect(delivered.filter((d) => d.from === s2)).toEqual([]);
  });

  test("more than 6 qualifying handoffs deliver only the newest 6", async () => {
    const plan = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ match: "pick T1", times: 1, result: pass(`m${n}`) }));
    const { repo, ctx } = direct([...plan, { match: "pick T1", result: { status: "PASS", action: "last" } }]);
    for (let i = 0; i < 8; i += 1) await runStage(ctx, "pick", step("pick", "T1"), { task: "T1" });
    const last = prompts(repo, "greet", /-pick-T1-/)[7];
    expect(last).not.toContain("did-m1");
    for (const n of [2, 3, 4, 5, 6, 7]) expect(last).toContain(`did-m${n}`);
    expect(handoffEvents(repo, "greet").filter((d) => d.to === seqsOf(repo, "greet", "pick", "T1")[7])).toHaveLength(6);
  });

  test("handoffs never cross tasks", async () => {
    const { repo, ctx } = direct([
      { match: "pick T1", result: pass("one") },
      { match: "pick T2", result: { status: "PASS", action: "other" } },
    ]);
    await runStage(ctx, "pick", step("pick", "T1"), { task: "T1" });
    await runStage(ctx, "pick", step("pick", "T2"), { task: "T2" });
    await runStage(ctx, "pick", step("pick", "T1"), { task: "T1" });
    const retryT1 = prompts(repo, "greet", /-pick-T1-/)[1];
    expect(retryT1).toContain("did-one");
    const [t2] = prompts(repo, "greet", /-pick-T2-/);
    expect(t2).not.toContain("did-one");
    expect(t2).not.toContain("## Handoffs");
  });

  test("cut, distill, review, and test steps get no handoffs and no handoff instruction where they write none", async () => {
    const { repo, ctx } = direct([
      { match: "pick T1", result: pass("early") },
      { match: "distill", result: { status: "PASS", action: "wrote" } },
      { match: "cut", result: { status: "PASS", action: "cut" } },
      { match: "branch review", result: { status: "PASS", action: "reviewed", findings: [] } },
    ]);
    await runStage(ctx, "pick", step("pick", "T1"), { task: "T1" });
    await runStage(ctx, "distill", step("distill"));
    await runStage(ctx, "cut", step("cut"));
    await runStage(ctx, "review", step("branch review"));
    for (const [stage, pattern] of [["distill", /-distill-/], ["cut", /-cut-/], ["review", /-review-/]] as const) {
      const [prompt] = prompts(repo, "greet", pattern);
      expect(prompt, stage).not.toContain("## Handoffs");
      expect(prompt, stage).not.toContain("did-early");
      expect(prompt, stage).not.toMatch(/handoff/i);
    }
    // The routing table is live: a retry pick does receive the earlier handoff.
    await runStage(ctx, "pick", step("pick", "T1"), { task: "T1" });
    expect(prompts(repo, "greet", /-pick-T1-/)[1]).toContain("did-early");
    const seqs = new Set([...seqsOf(repo, "greet", "distill"), ...seqsOf(repo, "greet", "cut"), ...seqsOf(repo, "greet", "review")]);
    expect(handoffEvents(repo, "greet").filter((d) => seqs.has(d.to))).toEqual([]);
  });

  test("a source step is asked to write a handoff; a writing pick's header carries the instruction", async () => {
    const { repo, ctx } = direct([{ match: "pick T1", result: { status: "PASS", action: "x" } }]);
    await runStage(ctx, "pick", step("pick", "T1"), { task: "T1" });
    const [prompt] = prompts(repo, "greet", /-pick-T1-/);
    expect(prompt).toMatch(/handoff/i);
    expect(prompt).toContain("learned");
    expect(prompt).toContain("traps");
  });

  test("INTEGRATE and REVIEW fix steps: pick gets each task's last passing pick, roast gets only the latest REVIEW pick's files and traps", async () => {
    const { repo, ctx } = direct([
      { match: "pick T1", times: 1, result: pass("a1") },
      { match: "pick T1", times: 1, result: { status: "FAIL", action: "broke it", handoff: ho("a2fail") } },
      { match: "pick T2", result: pass("b1") },
      { match: "pick INTEGRATE", result: pass("int") },
      { match: "pick REVIEW", result: pass("rev") },
      { match: "roast REVIEW", result: { status: "PASS", action: "ok" } },
    ]);
    await runStage(ctx, "pick", step("pick", "T1"), { task: "T1" });
    await runStage(ctx, "pick", step("pick", "T1"), { task: "T1" });
    await runStage(ctx, "pick", step("pick", "T2"), { task: "T2" });
    await runStage(ctx, "pick", step("pick", "INTEGRATE"), { task: "INTEGRATE" });
    await runStage(ctx, "pick", step("pick", "REVIEW"), { task: "REVIEW" });
    await runStage(ctx, "roast", step("roast", "REVIEW"), { task: "REVIEW" });

    const [integrate] = prompts(repo, "greet", /-pick-INTEGRATE-/);
    expect(integrate).toContain("did-a1");
    expect(integrate).toContain("did-b1");
    expect(integrate).not.toContain("did-a2fail");

    const [review] = prompts(repo, "greet", /-pick-REVIEW-/);
    expect(review).toContain("did-a1");
    expect(review).toContain("did-b1");
    expect(review).not.toContain("did-int");

    const [roastReview] = prompts(repo, "greet", /-roast-REVIEW-/);
    expect(roastReview).toContain(CLAIMS);
    expect(roastReview).toContain("file-rev.ts");
    expect(roastReview).toContain("trap-rev");
    expect(roastReview).not.toContain("did-rev");
    expect(roastReview).not.toContain("learned-rev");
    expect(roastReview).not.toContain("file-a1.ts");
  });
});

describe("taste", () => {
  const redHead = (sha: string): PrSnapshot => ({ sha, mergeable: "MERGEABLE", mergeState: "UNSTABLE", checks: [{ name: "test", bucket: "fail" }] });

  test("taste #3 receives brew's handoff and those of tastes #1 and #2", async () => {
    const { repo, ctx } = direct([
      { match: "brew", result: pass("brew") },
      { match: "taste", times: 1, result: pass("ta1") },
      { match: "taste", times: 1, result: pass("ta2") },
      { match: "taste", result: { status: "PASS", action: "third" } },
    ]);
    await runStage(ctx, "brew", step("brew"));
    for (let i = 0; i < 3; i += 1) await runStage(ctx, "taste", step("taste"));
    const [first, second, third] = prompts(repo, "greet", /-taste-/);
    expect(first).toContain("did-brew");
    expect(first).not.toContain("did-ta1");
    expect(second).toContain("did-brew");
    expect(second).toContain("did-ta1");
    for (const marker of ["did-brew", "did-ta1", "did-ta2"]) expect(third).toContain(marker);
    const order = ["did-brew", "did-ta1", "did-ta2"].map((m) => third.indexOf(m));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test("finish passes taste the earlier taste's handoff and records the delivery", async () => {
    const repo = tempRepo();
    const { config } = fakeSetup(repo, [
      { match: "taste", times: 1, result: pass("first-taste", "reran") },
      { match: "taste", result: { status: "PASS", action: "reran" } },
    ]);
    const ctx = quietCtx(newState({ slug: "pr-7", repo, ip: "", base: "master", phase: "finish" }), config);
    expect(await finish(ctx, fakeCi([redHead("a")]), 7)).toBe("waiting");
    const [first, second] = prompts(repo, "pr-7", /-taste-/);
    expect(first).not.toContain("## Handoffs");
    expect(second).toContain(HEADING);
    expect(second).toContain("did-first-taste");
    const [s1, s2] = seqsOf(repo, "pr-7", "taste");
    expect(handoffEvents(repo, "pr-7")).toContainEqual({ from: s1, to: s2 });
  });
});

describe("handoffsFor", () => {
  const seed = async () => {
    const { repo, ctx } = direct([
      { match: "test T1", result: pass("t") },
      { match: "pick T1", times: 1, result: pass("p1") },
      { match: "roast T1", times: 1, result: { status: "FAIL", action: "no", handoff: ho("r1") } },
      { match: "pick T1", result: pass("p2") },
      { match: "pick T2", result: pass("q") },
      { match: "brew", result: pass("bb") },
    ]);
    await runStage(ctx, "test", step("test", "T1"), { task: "T1" });
    await runStage(ctx, "pick", step("pick", "T1"), { task: "T1" });
    await runStage(ctx, "roast", step("roast", "T1"), { task: "T1" });
    await runStage(ctx, "pick", step("pick", "T1"), { task: "T1" });
    await runStage(ctx, "pick", step("pick", "T2"), { task: "T2" });
    return { repo, ctx, handoffsFor: await loadHandoffsFor() };
  };

  test("pick T1 gets the latest test T1 plus earlier picks and roasts of T1, oldest first, with source details", async () => {
    const { ctx, handoffsFor } = await seed();
    const routed = handoffsFor(ctx.state, { stage: "pick", task: "T1" });
    expect(routed.map((r) => r.handoff.did)).toEqual(["did-t", "did-p1", "did-r1", "did-p2"]);
    expect(routed[2]).toMatchObject({ stage: "roast", agent: "beta", status: "FAIL" });
    expect(routed[1]).toMatchObject({ stage: "pick", agent: "alpha", status: "PASS" });
    expect(routed.map((r) => r.seq)).toEqual([...routed.map((r) => r.seq)].sort((a, b) => a - b));
  });

  test("roast T1 gets only the latest pick T1 with files and traps", async () => {
    const { ctx, handoffsFor } = await seed();
    const routed = handoffsFor(ctx.state, { stage: "roast", task: "T1" });
    expect(routed).toHaveLength(1);
    expect(routed[0].handoff).toEqual({ files: ["file-p2.ts"], traps: ["trap-p2"] });
  });

  test("brew gets each task's last passing pick", async () => {
    const { ctx, handoffsFor } = await seed();
    const routed = handoffsFor(ctx.state, { stage: "brew" });
    expect(routed.map((r) => r.handoff.did).sort()).toEqual(["did-p2", "did-q"]);
  });

  test("stages that receive nothing return an empty list", async () => {
    const { ctx, handoffsFor } = await seed();
    for (const stage of ["distill", "cut", "test", "review", "compound", "cellar", "approve", "calibrate"]) {
      expect(handoffsFor(ctx.state, { stage }), stage).toEqual([]);
    }
    expect(handoffsFor(ctx.state, { stage: "test", task: "T1" })).toEqual([]);
  });

  test("a run with no steps returns an empty list", async () => {
    const { ctx } = direct([]);
    const handoffsFor = await loadHandoffsFor();
    expect(handoffsFor(ctx.state, { stage: "pick", task: "T1" })).toEqual([]);
  });
});
