// T5: routing cases the brief left implicit — seq order under the cap, fix-task picks kept
// out of "each task's last passing pick", roast copies labelled, and which headers ask.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STAGES, type Stage } from "../src/config.ts";
import { handoffsFor } from "../src/handoff.ts";
import { runStage } from "../src/step.ts";
import { newState, runDir } from "../src/state.ts";
import { fakeSetup, quietCtx, tempRepo } from "./helpers.ts";

setDefaultTimeout(60_000);

const CLAIMS = "Claims from the implementer: verify them, do not trust them";
const ho = (name: string) => ({ did: `did-${name}`, learned: [`learned-${name}`], traps: [`trap-${name}`], files: [`file-${name}.ts`] });
const pass = (name: string) => ({ status: "PASS", action: "done", handoff: ho(name) });
const step = (stage: string, task?: string): string => `## Step: ${stage}${task ? ` ${task}` : ""} marker\n`;

const direct = (plan: unknown[]) => {
  const repo = tempRepo();
  const { config } = fakeSetup(repo, plan);
  const ctx = quietCtx(newState({ slug: "route", repo, ip: "", base: "master", phase: "build" }), config);
  return { repo, ctx };
};

const prompts = (repo: string, pattern: RegExp): string[] => {
  const dir = join(runDir(repo, "route"), "steps");
  return readdirSync(dir).filter((f) => pattern.test(f) && f.endsWith(".prompt.md")).sort().map((f) => readFileSync(join(dir, f), "utf8"));
};

describe("each task's last passing pick", () => {
  test("a task that passes again after six other tasks is the newest, so the cap keeps it", async () => {
    const tasks = ["T1", "T2", "T3", "T4", "T5", "T6", "T7"];
    const { ctx } = direct([
      { match: "pick T1", times: 1, result: pass("T1-old") },
      ...tasks.slice(1).map((t) => ({ match: `pick ${t}`, result: pass(t) })),
      { match: "pick T1", result: pass("T1-new") },
    ]);
    for (const t of tasks) await runStage(ctx, "pick", step("pick", t), { task: t });
    await runStage(ctx, "pick", step("pick", "T1"), { task: "T1" });
    const routed = handoffsFor(ctx.state, { stage: "brew" });
    expect(routed).toHaveLength(6);
    expect(routed.at(-1)?.handoff.did).toBe("did-T1-new");
    expect(routed.map((r) => r.handoff.did)).not.toContain("did-T2");
    expect(routed.map((r) => r.seq)).toEqual([...routed.map((r) => r.seq)].sort((a, b) => a - b));
  });

  test("INTEGRATE and REVIEW fix picks never count as a task's pick, and roast INTEGRATE is labelled claims", async () => {
    const { repo, ctx } = direct([
      { match: "pick T1", times: 1, result: pass("a1") },
      { match: "pick T1", result: { status: "FAIL", action: "broke", handoff: ho("a2") } },
      { match: "pick T2", result: pass("b1") },
      { match: "pick INTEGRATE", result: pass("int") },
      { match: "pick REVIEW", result: pass("rev") },
      { match: "roast INTEGRATE", result: { status: "PASS", action: "ok" } },
    ]);
    await runStage(ctx, "pick", step("pick", "T1"), { task: "T1" });
    await runStage(ctx, "pick", step("pick", "T1"), { task: "T1" });
    await runStage(ctx, "pick", step("pick", "T2"), { task: "T2" });
    await runStage(ctx, "pick", step("pick", "INTEGRATE"), { task: "INTEGRATE" });
    await runStage(ctx, "pick", step("pick", "REVIEW"), { task: "REVIEW" });
    for (const query of [{ stage: "brew" }, { stage: "pick", task: "INTEGRATE" }, { stage: "pick", task: "REVIEW" }]) {
      expect(handoffsFor(ctx.state, query).map((r) => r.handoff.did), JSON.stringify(query)).toEqual(["did-a1", "did-b1"]);
    }
    await runStage(ctx, "roast", step("roast", "INTEGRATE"), { task: "INTEGRATE" });
    const [roast] = prompts(repo, /-roast-INTEGRATE-/);
    expect(roast).toContain(CLAIMS);
    for (const marker of ["file-a1.ts", "trap-a1", "file-b1.ts", "trap-b1"]) expect(roast).toContain(marker);
    for (const marker of ["did-", "learned-", "file-a2.ts", "file-int.ts", "file-rev.ts"]) expect(roast).not.toContain(marker);
  });

  test("roast REVIEW reads only the latest REVIEW pick", async () => {
    const { ctx } = direct([
      { match: "pick REVIEW", times: 1, result: pass("rev1") },
      { match: "pick REVIEW", result: pass("rev2") },
    ]);
    await runStage(ctx, "pick", step("pick", "REVIEW"), { task: "REVIEW" });
    await runStage(ctx, "pick", step("pick", "REVIEW"), { task: "REVIEW" });
    expect(handoffsFor(ctx.state, { stage: "roast", task: "REVIEW" }).map((r) => r.handoff)).toEqual([{ files: ["file-rev2.ts"], traps: ["trap-rev2"] }]);
  });
});

describe("which steps are asked to write a handoff", () => {
  test("test, pick, roast, brew, and taste headers ask; every other stage's header does not", async () => {
    const { repo, ctx } = direct([{ match: "", result: { status: "PASS", action: "x" } }]);
    for (const stage of STAGES) await runStage(ctx, stage as Stage, step(stage));
    const asks = new Set(["test", "pick", "roast", "brew", "taste"]);
    for (const stage of STAGES) {
      const [prompt] = prompts(repo, new RegExp(`^\\d+-${stage}-`));
      expect(prompt, stage).toBeDefined();
      if (asks.has(stage)) expect(prompt, stage).toContain("`handoff` key");
      else expect(prompt, stage).not.toMatch(/handoff/i);
    }
  });
});
