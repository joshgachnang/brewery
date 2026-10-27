// End-to-end runs against a temp git repo with scripted fake agents.
import { describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { answer } from "../src/commands/answer.ts";
import { runCut } from "../src/commands/cut.ts";
import { barrel } from "../src/commands/barrel.ts";
import { cutAndFix, distill, pour, sendForSignoff, writeDraft } from "../src/commands/distill.ts";
import { finish } from "../src/commands/finish.ts";
import { readIp, readStatus, parseTasks } from "../src/ip.ts";
import { runStage } from "../src/step.ts";
import { loadState, newState, readContext, runDir, saveState } from "../src/state.ts";
import type { PrSnapshot } from "../src/vcs.ts";
import { fakeCi, fakeSetup, IP, quietCtx, run, tempRepo } from "./helpers.ts";

setDefaultTimeout(30_000);

const green = (sha: string): PrSnapshot => ({ sha, mergeable: "MERGEABLE", mergeState: "CLEAN", checks: [{ name: "test", bucket: "pass" }] });
const red = (sha: string): PrSnapshot => ({ sha, mergeable: "MERGEABLE", mergeState: "UNSTABLE", checks: [{ name: "test", bucket: "fail" }] });
const pending = (sha: string): PrSnapshot => ({ sha, mergeable: "MERGEABLE", mergeState: "BLOCKED", checks: [{ name: "test", bucket: "pending" }] });

const events = (repo: string, slug: string): Record<string, unknown>[] =>
  readFileSync(join(runDir(repo, slug), "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

const stepPrompts = (repo: string, slug: string, pattern: RegExp): string[] => {
  const dir = join(runDir(repo, slug), "steps");
  return readdirSync(dir)
    .filter((f) => pattern.test(f) && f.endsWith(".prompt.md"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"));
};

test("brewery note records verbatim mid-run text for later steps without changing phase", async () => {
  const repo = tempRepo();
  const { config } = fakeSetup(repo, [{ match: "check notes", result: { status: "PASS", action: "read" } }]);
  const state = newState({ slug: "greet", repo, ip: "", base: "master", phase: "build" });
  saveState(state);
  const note = "  Keep the existing title.\nUse the short label.  ";
  const command = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), "note", "greet", note, "--repo", repo], { cwd: repo, env: process.env });
  expect(command.exitCode).toBe(0);
  const saved = JSON.parse(readFileSync(join(runDir(repo, "greet"), "state.json"), "utf8"));
  expect(saved.notes).toEqual([note]);
  expect(saved.phase).toBe("build");
  expect(readContext(state)).toContain(note);
  expect(events(repo, "greet").at(-1)).toMatchObject({ kind: "note", text: note });

  const ctx = quietCtx(saved, config);
  await runStage(ctx, "pick", "check notes", { task: "T3" });
  expect(stepPrompts(repo, "greet", /pick-T3/)[0]).toContain(note);
  expect(stepPrompts(repo, "greet", /pick-T3/)[0]).toContain("the human added, mid-run");

  // An already-running process may still hold the state from before the note.
  state.seq = ctx.state.seq;
  saveState(state);
  expect(loadState("greet", repo).notes).toEqual([note]);
  const staleCtx = quietCtx(state, config);
  await runStage(staleCtx, "pick", "check notes", { task: "T4" });
  expect(stepPrompts(repo, "greet", /pick-T4/)[0]).toContain(note);
});

test("brewery note rejects missing and blank text without changing the run", () => {
  const repo = tempRepo();
  fakeSetup(repo, []);
  const state = newState({ slug: "greet", repo, ip: "", base: "master", phase: "build" });
  saveState(state);
  for (const args of [["note", "greet"], ["note", "greet", "  "]]) {
    const command = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), ...args, "--repo", repo], { cwd: repo, env: process.env });
    expect(command.exitCode).toBe(1);
  }
  expect(readContext(state)).toBe("");
  expect(JSON.parse(readFileSync(join(runDir(repo, "greet"), "state.json"), "utf8")).notes).toEqual([]);
});

test("brewery note preserves simultaneous notes and text starting with dashes", async () => {
  const repo = tempRepo();
  fakeSetup(repo, []);
  const state = newState({ slug: "greet", repo, ip: "", base: "master", phase: "build" });
  saveState(state);
  const notes = ["-- keep the title", "Use the shorter label"];
  const commands = notes.map((note) => Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "note", "greet", note, "--repo", repo], { cwd: repo, env: process.env }));
  expect(await Promise.all(commands.map((command) => command.exited))).toEqual([0, 0]);
  expect(loadState("greet", repo).notes?.sort()).toEqual([...notes].sort());
  for (const note of notes) expect(readContext(state)).toContain(note);
});

test("resume recovers a killed roast and rejects concurrent run commands", async () => {
  const repo = tempRepo();
  mkdirSync(join(repo, "docs/plans"), { recursive: true });
  const ip = join(repo, "docs/plans/greet.md");
  writeFileSync(ip, IP("approved 2026-09-28"));
  fakeSetup(repo, [
    { match: "pick T1", write: { "greeting.txt": "hello\n" }, result: { status: "PASS", action: "built" } },
    { match: "roast T1", times: 1, sleepMs: 30000, result: { status: "PASS", action: "proven" } },
    { match: "roast T1", result: { status: "PASS", action: "proven" } },
    { match: "pick T2", result: { status: "BLOCKED", action: "needs decision", ask: [{ q: "Proceed?", rec: "retry", opts: ["retry", "stop"] }] } },
  ]);
  const state = newState({ slug: "greet", repo, ip, base: "master", phase: "approved" });
  saveState(state);
  const cli = join(import.meta.dir, "../src/cli.ts");
  const first = Bun.spawn(["bun", cli, "barrel", "greet", "--repo", repo, "--no-wait"], { cwd: repo, env: process.env, stdout: "pipe", stderr: "pipe" });
  const pidFile = join(runDir(repo, "greet"), "run.pid");
  try {
    for (let i = 0; i < 200 && (!existsSync(join(runDir(repo, "greet"), "events.jsonl")) || !events(repo, "greet").some((e) => e.kind === "step.start" && e.stage === "roast")); i++) await Bun.sleep(25);
    expect(existsSync(pidFile)).toBe(true);
    expect(Number(readFileSync(pidFile, "utf8"))).toBe(first.pid);
    const second = Bun.spawnSync(["bun", cli, "resume", "greet", "--repo", repo, "--go", "--no-wait"], { cwd: repo, env: process.env });
    expect(second.exitCode).toBe(1);
    expect(second.stderr.toString()).toContain("already running");
    first.kill("SIGKILL");
    await first.exited;
    const resumed = Bun.spawnSync(["bun", cli, "resume", "greet", "--repo", repo, "--go", "--no-wait"], { cwd: repo, env: process.env });
    expect(resumed.exitCode).toBe(3);
    expect(loadState("greet", repo).waiting?.kind).toBe("gate");
    expect(loadState("greet", repo).tasks.T1.status).toBe("passed");
    expect(events(repo, "greet").filter((e) => e.kind === "step.start" && e.stage === "roast")).toHaveLength(2);
    const starts = events(repo, "greet").filter((e) => e.kind === "step.start");
    expect(new Set(starts.map((e) => e.seq)).size).toBe(starts.length);
    expect(existsSync(pidFile)).toBe(false);
  } finally {
    first.kill("SIGKILL");
  }
});

describe("distill → sign-off → answer", () => {
  const cycleIp = IP("draft").replace("- [ ] **T1** — Add greeting file", "- [ ] **T1** — Add greeting file\n  - Depends on: T2");

  test.each([
    ["cycle", cycleIp, "Dependency cycle: T1 → T2 → T1"],
    ["unknown dependency", IP("draft").replace("- [ ] **T1** — Add greeting file", "- [ ] **T1** — Add greeting file\n  - Depends on: T99"), "T1 depends on unknown task T99"],
    ["self dependency", IP("draft").replace("- [ ] **T1** — Add greeting file", "- [ ] **T1** — Add greeting file\n  - Depends on: T1"), "T1 depends on itself"],
    ["duplicate task id", IP("draft").replace("- [ ] **T1** — Add greeting file\n- [ ] **T2** — Add farewell file", "- [ ] **T1** — Add greeting file\n  Depends on: none\n- [ ] **T1** — Add farewell file\n  Depends on: none"), "Duplicate task id: T1"],
  ])("non-structural approval with an unrepaired %s returns to sign-off with the problem", async (_kind, text, problem) => {
    const repo = tempRepo();
    const { config } = fakeSetup(repo, [
      { match: "distill step 12", write: { "docs/plans/g.md": text }, result: { status: "PASS", action: "applied", structural: false } },
      { match: "cut (attack the IP)", result: { status: "PASS", action: "cut", findings: [] } },
      { match: "distill step 10", result: { status: "PASS", action: "claimed fixed", structural: false } },
    ]);
    const ctx = quietCtx(newState({ slug: "g", repo, ip: join(repo, "docs/plans/g.md"), base: "master", phase: "signoff" }), config);
    mkdirSync(join(repo, "docs/plans"), { recursive: true });
    writeFileSync(ctx.state.ip, IP("draft"));
    await sendForSignoff(ctx, []);

    expect(await answer(ctx, "ok")).toBe("waiting");
    const saved = loadState("g", repo);
    expect(saved.phase).toBe("signoff");
    expect(saved.waiting?.kind).toBe("signoff");
    expect(saved.waiting?.message).toContain(problem);
    expect(readStatus(readIp(saved.ip))).toStartWith("awaiting sign-off");
    const [fix] = stepPrompts(repo, "g", /distill-alpha/).filter((p) => p.includes("## Step: distill step 10"));
    expect(fix).toContain(problem);
    expect(fix).toContain('"severity": "blocking"');
    expect(fix).toContain('"axis": "decomposition"');
  });

  test("a structural reply with an unrepaired cycle remains answerable through the CLI", async () => {
    const repo = tempRepo();
    const { config } = fakeSetup(repo, [
      { match: "distill step 12", times: 1, write: { "docs/plans/g.md": cycleIp }, result: { status: "PASS", action: "applied", structural: true } },
      { match: "distill step 12", write: { "docs/plans/g.md": IP("draft") }, result: { status: "PASS", action: "repaired", structural: false } },
      { match: "cut (attack the IP)", result: { status: "PASS", action: "cut", findings: [] } },
      { match: "distill step 10", result: { status: "PASS", action: "claimed fixed", structural: true, ask: Array.from({ length: 5 }, (_, i) => ({ q: `Choice ${i + 1}?`, rec: "Keep", opts: ["Keep", "Change"] })) } },
    ]);
    const ctx = quietCtx(newState({ slug: "g", repo, ip: join(repo, "docs/plans/g.md"), base: "master", phase: "signoff" }), config);
    mkdirSync(join(repo, "docs/plans"), { recursive: true });
    writeFileSync(ctx.state.ip, IP("draft"));
    await sendForSignoff(ctx, []);
    const cli = join(import.meta.dir, "../src/cli.ts");
    const first = Bun.spawnSync(["bun", cli, "answer", "g", "ok", "--repo", repo, "--no-wait"], { cwd: repo, env: process.env });
    expect(first.exitCode).toBe(3);
    const saved = loadState("g", repo);
    expect(saved.phase).toBe("signoff");
    expect(saved.waiting?.kind).toBe("signoff");
    expect(saved.waiting?.message).toContain("Dependency cycle: T1 → T2 → T1");
    expect(saved.waiting?.asks).toHaveLength(6);
    expect(readStatus(readIp(saved.ip))).toStartWith("awaiting sign-off");

    const second = Bun.spawnSync(["bun", cli, "answer", "g", "ok", "--repo", repo, "--no-wait"], { cwd: repo, env: process.env });
    expect(second.exitCode).toBe(0);
    const approved = loadState("g", repo);
    expect(approved.phase).toBe("approved");
    expect(approved.waiting).toBeUndefined();
    expect(approved.answers.map((a) => a.a)).toEqual(["ok", "ok"]);
    expect(readStatus(readIp(approved.ip))).toStartWith("approved");
  });

  test.each(["ok", "no: revise the dependencies", "1b please"])("an invalid graph repaired during cut/fix handles reply %s", async (reply) => {
    const repo = tempRepo();
    const { config } = fakeSetup(repo, [
      { match: "distill step 12", write: { "docs/plans/g.md": cycleIp }, result: { status: "PASS", action: "applied", structural: false } },
      { match: "cut (attack the IP)", result: { status: "PASS", action: "cut", findings: [] } },
      { match: "distill step 10", write: { "docs/plans/g.md": IP("draft") }, result: { status: "PASS", action: "repaired", structural: false } },
    ]);
    const ctx = quietCtx(newState({ slug: "g", repo, ip: join(repo, "docs/plans/g.md"), base: "master", phase: "signoff" }), config);
    mkdirSync(join(repo, "docs/plans"), { recursive: true });
    writeFileSync(ctx.state.ip, IP("draft"));
    await sendForSignoff(ctx, []);

    const approving = reply === "ok";
    expect(await answer(ctx, reply)).toBe(approving ? "approved" : "waiting");
    const saved = loadState("g", repo);
    expect(saved.phase).toBe(approving ? "approved" : "signoff");
    expect(saved.waiting?.kind).toBe(approving ? undefined : "signoff");
    expect(readStatus(readIp(saved.ip))).toStartWith(approving ? "approved" : "awaiting sign-off");
  });

  test.each(["ok", "no: revise the dependencies", "1b please"])("a cut failure while processing %s preserves durable sign-off", async (reply) => {
    const repo = tempRepo();
    const { config } = fakeSetup(repo, [
      { match: "distill step 12", result: { status: "PASS", action: "applied", structural: true } },
    ]);
    config.stages.cut = [];
    const ctx = quietCtx(newState({ slug: "g", repo, ip: join(repo, "docs/plans/g.md"), base: "master", phase: "signoff" }), config);
    mkdirSync(join(repo, "docs/plans"), { recursive: true });
    writeFileSync(ctx.state.ip, IP("draft"));
    await sendForSignoff(ctx, []);
    const waiting = ctx.state.waiting;

    await expect(answer(ctx, reply)).rejects.toThrow("no available agent for cut");
    const saved = loadState("g", repo);
    expect(saved.phase).toBe("signoff");
    expect(saved.waiting).toEqual(waiting);
    expect(readStatus(readIp(saved.ip))).toStartWith("awaiting sign-off");
  });

  test("rejects a cyclic draft and reaches sign-off only after a usable draft is written", async () => {
    const repo = tempRepo();
    const { config } = fakeSetup(repo, [
      { match: "distill (write the IP)", times: 1, write: { "docs/plans/g.md": cycleIp }, result: { status: "PASS", action: "drafted" } },
      { match: "distill (write the IP)", write: { "docs/plans/g.md": IP("draft") }, result: { status: "PASS", action: "repaired" } },
      { match: "cut (attack the IP)", result: { status: "PASS", action: "cut", findings: [] } },
    ]);
    const ctx = quietCtx(newState({ slug: "g", repo, ip: join(repo, "docs/plans/g.md"), base: "master", phase: "distill" }), config);
    await distill(ctx, "Add a greeting");
    expect(ctx.lines.join("\n")).toContain("unusable: Dependency cycle: T1 → T2 → T1");
    expect(ctx.state.history.filter((h) => h.stage === "distill")).toHaveLength(2);
    expect(ctx.state.waiting?.kind).toBe("signoff");
  });

  test.each([
    ["cycle", cycleIp, "T1 → T2 → T1"],
    ["unknown dependency", IP("draft").replace("- [ ] **T1** — Add greeting file", "- [ ] **T1** — Add greeting file\n  - Depends on: T99"), "T1 depends on unknown task T99"],
    ["self dependency", IP("draft").replace("- [ ] **T1** — Add greeting file", "- [ ] **T1** — Add greeting file\n  - Depends on: T1"), "T1 depends on itself"],
  ])("a draft with an unrepaired %s exhausts the two draft attempts without sign-off", async (_kind, text, problem) => {
    const repo = tempRepo();
    const { config } = fakeSetup(repo, [
      { match: "distill (write the IP)", write: { "docs/plans/g.md": text }, result: { status: "PASS", action: "drafted" } },
    ]);
    const ctx = quietCtx(newState({ slug: "g", repo, ip: join(repo, "docs/plans/g.md"), base: "master", phase: "distill" }), config);
    saveState(ctx.state);
    await expect(writeDraft(ctx, "Add a greeting")).rejects.toThrow(problem);
    expect(ctx.state.history).toHaveLength(2);
    expect(ctx.state.waiting).toBeUndefined();
    expect(readStatus(readIp(ctx.state.ip))).toBe("draft");
  });

  test("repairs an existing cycle even when Cut returns no findings", async () => {
    const repo = tempRepo();
    const { config } = fakeSetup(repo, [
      { match: "cut (attack the IP)", result: { status: "PASS", action: "cut", findings: [] } },
      { match: "distill step 10", write: { "docs/plans/g.md": IP("draft") }, result: { status: "PASS", action: "repaired" } },
    ]);
    const ctx = quietCtx(newState({ slug: "g", repo, ip: join(repo, "docs/plans/g.md"), base: "master", phase: "distill" }), config);
    mkdirSync(join(repo, "docs/plans"), { recursive: true });
    writeFileSync(ctx.state.ip, cycleIp);
    saveState(ctx.state);
    await sendForSignoff(ctx, await cutAndFix(ctx, [], 2));
    const [fix] = stepPrompts(repo, "g", /distill-alpha/);
    expect(fix).toContain("T1 → T2 → T1");
    expect(fix).toContain('"axis": "decomposition"');
    expect(ctx.state.waiting?.kind).toBe("signoff");
  });

  test("returns a cycle introduced by a fix as a blocking decomposition finding until repaired", async () => {
    const repo = tempRepo();
    const { config } = fakeSetup(repo, [
      { match: "distill (write the IP)", write: { "docs/plans/g.md": IP("draft") }, result: { status: "PASS", action: "drafted" } },
      { match: "cut (attack the IP)", agent: "alpha", times: 1, result: { status: "PASS", action: "cut", findings: [{ severity: "blocking", attack: "Split the task", evidence: "Two behaviors" }] } },
      { match: "cut (attack the IP)", result: { status: "PASS", action: "cut", findings: [] } },
      { match: "distill step 10", times: 1, write: { "docs/plans/g.md": cycleIp }, result: { status: "PASS", action: "fixed", structural: false } },
      { match: "distill step 10", write: { "docs/plans/g.md": IP("draft") }, result: { status: "PASS", action: "repaired", structural: false } },
    ]);
    const ctx = quietCtx(newState({ slug: "g", repo, ip: join(repo, "docs/plans/g.md"), base: "master", phase: "distill" }), config);
    await distill(ctx, "Add a greeting");
    const fixes = stepPrompts(repo, "g", /distill-alpha/).filter((p) => p.includes("## Step: distill step 10"));
    expect(fixes).toHaveLength(2);
    expect(fixes[1]).toContain("T1 → T2 → T1");
    expect(fixes[1]).toContain('"severity": "blocking"');
    expect(fixes[1]).toContain('"axis": "decomposition"');
    expect(ctx.state.cutRounds).toBe(2);
    expect(ctx.state.waiting?.kind).toBe("signoff");
    expect(readStatus(readIp(ctx.state.ip))).toStartWith("awaiting sign-off");
  });

  test("an unrepaired cycle introduced by a fix exhausts cut rounds and never reaches sign-off", async () => {
    const repo = tempRepo();
    const { config } = fakeSetup(repo, [
      { match: "distill (write the IP)", write: { "docs/plans/g.md": IP("draft") }, result: { status: "PASS", action: "drafted" } },
      { match: "cut (attack the IP)", agent: "alpha", times: 1, result: { status: "PASS", action: "cut", findings: [{ severity: "blocking", attack: "Split the task", evidence: "Two behaviors" }] } },
      { match: "cut (attack the IP)", result: { status: "PASS", action: "cut", findings: [] } },
      { match: "distill step 10", write: { "docs/plans/g.md": cycleIp }, result: { status: "PASS", action: "claimed fixed", structural: false } },
    ]);
    const ctx = quietCtx(newState({ slug: "g", repo, ip: join(repo, "docs/plans/g.md"), base: "master", phase: "distill" }), config);
    await expect(distill(ctx, "Add a greeting")).rejects.toThrow("T1 → T2 → T1");
    expect(ctx.state.cutRounds).toBe(config.limits.cutRounds);
    const fixes = stepPrompts(repo, "g", /distill-alpha/).filter((p) => p.includes("## Step: distill step 10"));
    expect(fixes).toHaveLength(2);
    expect(fixes[1]).toContain("T1 → T2 → T1");
    expect(ctx.state.waiting).toBeUndefined();
    expect(ctx.state.phase).toBe("distill");
    expect(readStatus(readIp(ctx.state.ip))).toBe("draft");
  });

  test("zero cut rounds cannot pass an existing invalid graph to sign-off", async () => {
    const repo = tempRepo();
    const { config } = fakeSetup(repo, []);
    const ctx = quietCtx(newState({ slug: "g", repo, ip: join(repo, "docs/plans/g.md"), base: "master", phase: "distill" }), config);
    mkdirSync(join(repo, "docs/plans"), { recursive: true });
    writeFileSync(ctx.state.ip, cycleIp);
    await expect(cutAndFix(ctx, [], 0)).rejects.toThrow("T1 → T2 → T1");
    expect(ctx.state.history).toHaveLength(0);
    expect(ctx.state.waiting).toBeUndefined();
  });

  test("writes the IP, cuts it in a clean tree with only the human's words, and waits for sign-off", async () => {
    const repo = tempRepo();
    const ask = { q: "Plain text or markdown?", rec: "Plain text", opts: ["Plain text", "Markdown"] };
    const { planPath, config } = fakeSetup(repo, [
      { match: "distill (write the IP)", write: { "docs/plans/greet.md": IP("draft") }, result: { status: "PASS", action: "sign off", ip: "docs/plans/greet.md", ask: [ask] } },
      { match: "cut", agent: "alpha", result: { status: "PASS", action: "attacked", findings: [{ severity: "blocking", where: "T2", attack: "Farewell was never requested", evidence: "request says greeting only" }] } },
      { match: "cut", agent: "beta", result: { status: "PASS", action: "attacked", findings: [{ severity: "nit", attack: "vibes", evidence: "" }] } },
      { match: "distill step 10", result: { status: "PASS", action: "fixed", structural: false, tally: { edited: 1, moved: 0, rebutted: 0 }, ask: [ask] } },
      { match: "distill step 12", result: { status: "PASS", action: "applied" } },
    ]);
    const state = newState({ slug: "greet", repo, ip: join(repo, "docs/plans/2026-09-27-greet.md"), base: "master", phase: "distill" });
    const ctx = quietCtx(state, config);

    await distill(ctx, "Add a greeting file.");

    expect(state.ip).toBe(join(repo, "docs/plans/greet.md"));
    expect(state.waiting?.kind).toBe("signoff");
    expect(readStatus(readIp(state.ip))).toStartWith("awaiting sign-off");
    expect(state.waiting?.message).toContain("1. Plain text or markdown? a) Plain text (recommended) b) Markdown");
    const beforeAnswer = events(repo, "greet");
    expect(beforeAnswer.filter((event) => event.kind === "step.start")).toHaveLength(4);
    expect(beforeAnswer.filter((event) => event.kind === "step.end")).toHaveLength(4);
    for (const start of beforeAnswer.filter((event) => event.kind === "step.start")) {
      const end = beforeAnswer.find((event) => event.kind === "step.end" && event.seq === start.seq);
      expect(end).toBeDefined();
      expect(beforeAnswer.indexOf(start)).toBeLessThan(beforeAnswer.indexOf(end as Record<string, unknown>));
    }
    expect(beforeAnswer[0]).toMatchObject({ kind: "step.start", seq: 1, stage: "distill", agent: "alpha" });
    expect(beforeAnswer[1]).toMatchObject({ kind: "step.end", seq: 1, status: "PASS", action: "sign off" });
    expect(beforeAnswer.at(-1)).toMatchObject({ kind: "waiting", waitingKind: "signoff", ip: state.ip, message: state.waiting?.message });
    expect(beforeAnswer.every((event) => typeof event.t === "string" && !Number.isNaN(Date.parse(String(event.t))))).toBe(true);

    const calls = readFileSync(`${planPath}.calls.log`, "utf8").trim().split("\n").map((l) => l.split("\t"));
    const cutCalls = calls.filter((c) => c[1].startsWith("cut"));
    expect(cutCalls.map((c) => c[0]).sort()).toEqual(["alpha", "beta"]);
    expect(cutCalls.every((c) => c[2] !== repo && c[3] === "false")).toBe(true);

    const [fixPrompt] = stepPrompts(repo, "greet", /distill-alpha/).filter((p) => p.includes("## Step: distill step 10"));
    expect(fixPrompt).toContain("Farewell was never requested");
    expect(fixPrompt).not.toContain("vibes");

    const outcome = await answer(ctx, "ok, 1b");
    expect(outcome).toBe("approved");
    expect(readStatus(readIp(state.ip))).toStartWith("approved");
    expect(state.waiting).toBeUndefined();
    expect(events(repo, "greet").slice(-4).map((event) => event.kind)).toEqual(["resumed", "note", "step.start", "step.end"]);
    const context = readContext(state);
    expect(context).toContain("Add a greeting file.");
    expect(context).toContain("ok, 1b");
  });

  test("an answer without approval asks again instead of approving", async () => {
    const repo = tempRepo();
    const { config } = fakeSetup(repo, [
      { match: "distill (write the IP)", write: { "docs/plans/g.md": IP("draft") }, result: { status: "PASS", action: "x", ip: "docs/plans/g.md" } },
      { match: "cut", result: { status: "PASS", action: "x", findings: [] } },
      { match: "distill step 12", result: { status: "PASS", action: "applied", ask: [] } },
    ]);
    const state = newState({ slug: "g", repo, ip: join(repo, "docs/plans/g.md"), base: "master", phase: "distill" });
    const ctx = quietCtx(state, config);
    await distill(ctx, "Add a greeting");
    expect(await answer(ctx, "1b please")).toBe("waiting");
    expect(state.waiting?.kind).toBe("signoff");
    expect(readStatus(readIp(state.ip))).toStartWith("awaiting sign-off");
  });
});

describe("cut's held and unchecked lines", () => {
  test("an empty findings table with unchecked parts still goes to the fixer, and held parts do not", async () => {
    const repo = tempRepo();
    const { config } = fakeSetup(repo, [
      { match: "distill (write the IP)", write: { "docs/plans/g.md": IP("draft") }, result: { status: "PASS", action: "x", ip: "docs/plans/g.md" } },
      { match: "cut", agent: "alpha", result: { status: "PASS", action: "attacked", findings: [], wellReasoned: ["T1 matches the request: 'add a greeting'"], couldNotAssess: ["Whether the deploy host has write access: no access"] } },
      { match: "cut", agent: "beta", result: { status: "PASS", action: "attacked", findings: [] } },
      { match: "distill step 10", result: { status: "PASS", action: "recorded", structural: false } },
    ]);
    const state = newState({ slug: "g", repo, ip: join(repo, "docs/plans/g.md"), base: "master", phase: "distill" });
    const ctx = quietCtx(state, config);
    await distill(ctx, "Add a greeting");
    expect(ctx.lines.join("\n")).toContain("cut: 0 findings (0 blocking), 1 well-reasoned, 1 couldn't assess from alpha, beta");
    const [fixPrompt] = stepPrompts(repo, "g", /distill-alpha/).filter((p) => p.includes("## Step: distill step 10"));
    expect(fixPrompt).toContain("[alpha] Whether the deploy host has write access: no access");
    expect(fixPrompt).not.toContain("add a greeting'");
  });

  test("a clean cut with nothing unchecked skips the fixer", async () => {
    const repo = tempRepo();
    const { config } = fakeSetup(repo, [
      { match: "distill (write the IP)", write: { "docs/plans/g.md": IP("draft") }, result: { status: "PASS", action: "x", ip: "docs/plans/g.md" } },
      { match: "cut", result: { status: "PASS", action: "attacked", findings: [], wellReasoned: ["T1 holds"] } },
    ]);
    const state = newState({ slug: "g", repo, ip: join(repo, "docs/plans/g.md"), base: "master", phase: "distill" });
    await distill(quietCtx(state, config), "Add a greeting");
    expect(stepPrompts(repo, "g", /distill-alpha/).some((p) => p.includes("## Step: distill step 10"))).toBe(false);
  });
});

describe("cut cleanup failures", () => {
  for (const failure of ["exit", "spawn"] as const) {
    for (const successful of [false, true]) {
      test(`preserves ${successful ? "findings" : "the cut error"} when removal fails at ${failure}`, async () => {
        const repo = tempRepo();
        const ip = join(repo, "plan.md");
        writeFileSync(ip, IP("draft"));
        const finding = { severity: "blocking" as const, attack: "Missing greeting", evidence: "No greeting in the plan" };
        const { config } = fakeSetup(repo, [{ match: "cut", result: { status: "PASS", action: "attacked", findings: [finding] } }]);
        config.stages.cut = successful ? ["alpha"] : [];
        const ctx = quietCtx(newState({ slug: "greet", repo, ip, base: "master", phase: "distill" }), config);
        const spawn = Bun.spawn;
        let tree: string | undefined;
        // Force failure only at the OS boundary; keep the real stage and Git repo.
        const spy = spyOn(Bun, "spawn").mockImplementation(((argv: string[], options: unknown) => {
          if (argv[0] === "git" && argv[1] === "worktree" && argv[2] === "remove") {
            tree = argv.at(-1);
            if (failure === "spawn") throw new Error("cleanup spawn unavailable");
            return spawn(["git", "worktree", "remove", "--force", join(repo, "missing-tree")], options as Parameters<typeof spawn>[1]);
          }
          return spawn(argv, options as Parameters<typeof spawn>[1]);
        }) as typeof Bun.spawn);
        try {
          if (successful) expect(await runCut(ctx)).toEqual({ findings: [{ ...finding, agent: "alpha" }], wellReasoned: [], couldNotAssess: [] });
          else await expect(runCut(ctx)).rejects.toThrow("brewery: no available agent for cut");
          expect(ctx.lines.some((line) => line.includes("cleanup") && line.includes(tree!))).toBe(true);
          expect(ctx.lines.join("\n")).toContain(failure === "spawn" ? "cleanup spawn unavailable" : "not a working tree");
        } finally {
          spy.mockRestore();
          if (tree) run(repo, "git", "worktree", "remove", "--force", tree);
        }
      });
    }
  }
});

describe("barrel", () => {
  const setupApproved = (plan: unknown[]): { repo: string; ctx: ReturnType<typeof quietCtx> } => {
    const repo = tempRepo();
    mkdirSync(join(repo, "docs/plans"), { recursive: true });
    writeFileSync(join(repo, "docs/plans/greet.md"), IP("approved 2026-09-27"));
    const { config } = fakeSetup(repo, plan);
    const state = newState({ slug: "greet", repo, ip: join(repo, "docs/plans/greet.md"), base: "master", phase: "approved" });
    return { repo, ctx: quietCtx(state, config) };
  };

  const diamond = IP("approved 2026-09-27").replace(
    "- [ ] **T1** — Add greeting file\n- [ ] **T2** — Add farewell file",
    "- [ ] **T1** — Root\n  - Depends on: none\n- [ ] **T2** — Left\n  - Depends on: T1\n- [ ] **T3** — Right\n  - Depends on: T1\n- [ ] **T4** — Join\n  - Depends on: T2, T3",
  );
  const successfulTasks = (ids: string[]) => [
    ...ids.flatMap((id) => [
      { match: `pick ${id}`, sleepMs: 250, write: { [`${id}.txt`]: `${id}\n` }, result: { status: "PASS", action: "built" } },
      { match: `roast ${id}`, result: { status: "PASS", action: "proven" } },
    ]),
    { match: "roast INTEGRATE", result: { status: "PASS", action: "combined tree proven" } },
    { match: "branch review", result: { status: "PASS", action: "reviewed", findings: [] } },
    { match: "brew", result: { status: "PASS", action: "opened", pr: 7 } },
  ];
  const timings = (ctx: ReturnType<typeof quietCtx>) => readFileSync(`${ctx.config.agents.alpha.env?.FAKE_PLAN}.timings.log`, "utf8")
    .trim().split("\n").map((line) => {
      const [step, event, at] = line.split("\t");
      return { step, event, at: Number(at) };
    });

  test("duplicate task ids are rejected before any task starts", async () => {
    const { repo, ctx } = setupApproved([]);
    const text = IP("approved 2026-09-27").replace(
      "- [ ] **T1** — Add greeting file\n- [ ] **T2** — Add farewell file",
      "- [ ] **T1** — Add greeting file\n  Depends on: none\n- [ ] **T1** — Add farewell file\n  Depends on: none",
    );
    writeFileSync(ctx.state.ip, text);
    const head = run(repo, "git", "rev-parse", "HEAD");

    await expect(barrel(ctx, fakeCi([green("a")]))).rejects.toThrow("brewery: invalid task graph: Duplicate task id: T1");

    expect(ctx.state.tasks).toEqual({});
    expect(ctx.state.history).toEqual([]);
    expect(existsSync(`${ctx.config.agents.alpha.env?.FAKE_PLAN}.timings.log`)).toBe(false);
    expect(existsSync(join(runDir(repo, "greet"), "worktrees"))).toBe(false);
    expect(run(repo, "git", "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(run(repo, "git", "branch", "--list", "brewery/greet/*")).toBe("");
    expect(run(repo, "git", "rev-parse", "HEAD")).toBe(head);
    expect(readIp(ctx.state.ip)).toBe(text);
  });

  test("integrated roast repairs a combined-tree failure before branch review", async () => {
    const failure = { need: "combined greeting", want: "compatible tasks", got: "incompatible", ev: "bun test: combined greeting failed" };
    const { repo, ctx } = setupApproved([
      { match: "roast INTEGRATE", agent: "beta", times: 1, result: { status: "FAIL", action: "repair combined greeting", fail: [failure] } },
      { match: "roast INTEGRATE", result: { status: "PASS", action: "combined tree proven" } },
      { match: "pick INTEGRATE", write: { "integration.txt": "compatible\n" }, result: { status: "PASS", action: "repaired" } },
      ...successfulTasks(["T1", "T2", "T3", "T4"]).map((entry) =>
        ["pick T2", "pick T3"].includes(entry.match)
          ? { ...entry, signal: entry.match, waitFor: [entry.match === "pick T2" ? "pick T3" : "pick T2"] } : entry),
    ]);
    writeFileSync(ctx.state.ip, diamond);
    ctx.config.stages.roast = ["alpha", "beta"];
    expect(await barrel(ctx, fakeCi([green("a")]))).toBe("done");
    expect(readFileSync(join(repo, "integration.txt"), "utf8")).toBe("compatible\n");
    expect(run(repo, "git", "log", "--format=%s", "master..HEAD").split("\n")).toEqual([
      "Fix integration of parallel tasks", "Join", expect.any(String), expect.any(String), "Root",
    ]);
    const history = ctx.state.history;
    const integrated = history.filter((e) => e.task === "INTEGRATE");
    expect(integrated.filter((e) => e.stage === "roast")).toHaveLength(4);
    expect(integrated.filter((e) => e.stage === "pick")).toHaveLength(1);
    expect(Math.min(...history.filter((e) => e.stage === "review").map((e) => e.seq)))
      .toBeGreaterThan(Math.max(...integrated.map((e) => e.seq)));
    const fixPrompt = stepPrompts(repo, "greet", /-pick-INTEGRATE-/)[0];
    expect(fixPrompt).toContain(failure.ev);
    expect(fixPrompt).toContain("[beta]");
    const roastPrompt = stepPrompts(repo, "greet", /-roast-INTEGRATE-/)[0];
    expect(roastPrompt).toContain("every task's acceptance criteria on the combined tree");
    expect(roastPrompt).toContain("full test command");
    const calls = readFileSync(`${ctx.config.agents.alpha.env?.FAKE_PLAN}.calls.log`, "utf8").split("\n");
    expect(calls.filter((line) => line.includes("INTEGRATE")).every((line) => line.split("\t")[2] === repo)).toBe(true);
    expect(run(repo, "git", "status", "--porcelain")).toBe("");
  });

  for (const reply of ["retry", "ship", "stop"]) {
    test(`integration exhaustion persists its gate and handles ${reply}`, async () => {
      const { repo, ctx } = setupApproved([
        { match: "roast INTEGRATE", result: { status: "FAIL", action: "combined failure", fail: [{ need: "compatibility", want: "pass", got: "fail", ev: "bun test: integration failed" }] } },
        { match: "pick INTEGRATE", result: { status: "PASS", action: "no repair found" } },
        ...successfulTasks([]),
      ]);
      // Resume an already landed parallel build; no task gets rebuilt.
      writeFileSync(ctx.state.ip, IP("approved 2026-09-27").replaceAll("- [ ]", "- [x]"));
      run(repo, "git", "add", "docs/plans/greet.md");
      run(repo, "git", "commit", "-m", "Landed tasks");
      ctx.state.parallelRan = true;
      ctx.config.limits.reviewRounds = 1;
      const ci = fakeCi([green("a")]);
      expect(await barrel(ctx, ci)).toBe("waiting");
      expect(ctx.state.phase).toBe("integrate");
      expect(ctx.state.integrationRounds).toBe(1);
      expect(ctx.state.reviewRounds).toBe(0);
      expect(ctx.state.waiting?.task).toBe("INTEGRATE");
      expect(ctx.state.waiting?.asks[0].opts).toEqual(["retry", "ship", "stop"]);
      expect(ctx.state.waiting?.message).toContain("integration failed");
      expect(ctx.state.history.filter((e) => e.task === "INTEGRATE" && e.stage === "roast")).toHaveLength(2);
      expect(ctx.state.history.some((e) => e.stage === "review")).toBe(false);
      expect(run(repo, "git", "rev-list", "--count", "master..HEAD")).toBe("0");
      expect(await answer(ctx, reply)).toBe(reply === "stop" ? "stopped" : "continue");
      if (reply === "stop") {
        expect(ctx.state.phase).toBe("integrate");
        expect(ctx.state.integrationRounds).toBe(1);
        return;
      }
      if (reply === "ship") {
        expect(ctx.state.phase).toBe("review");
        expect(await barrel(ctx, ci)).toBe("done");
        expect(ctx.state.history.filter((e) => e.task === "INTEGRATE" && e.stage === "roast")).toHaveLength(2);
      } else {
        expect(ctx.state.integrationRounds).toBe(0);
        // Reload durable state to prove the bounded integration retry survives a new invocation.
        const resumed = quietCtx(JSON.parse(readFileSync(join(runDir(repo, "greet"), "state.json"), "utf8")), ctx.config);
        expect(await barrel(resumed, ci)).toBe("waiting");
        expect(resumed.state.integrationRounds).toBe(1);
        expect(resumed.state.history.filter((e) => e.task === "INTEGRATE" && e.stage === "pick")).toHaveLength(2);
      }
    });
  }

  for (const reply of ["retry: retained repair is approved", "ship"]) {
    test(`resumed BLOCKED integration Pick commits retained repairs on ${reply}`, async () => {
      const { repo, ctx } = setupApproved([
        { match: "roast INTEGRATE", times: 1, result: { status: "FAIL", action: "repair" } },
        { match: "pick INTEGRATE", write: { "retained.txt": "repair\n" }, result: { status: "BLOCKED", action: "approve retained repair" } },
        ...successfulTasks([]),
      ]);
      writeFileSync(ctx.state.ip, IP("approved 2026-09-27").replaceAll("- [ ]", "- [x]"));
      run(repo, "git", "add", "docs/plans/greet.md");
      run(repo, "git", "commit", "-m", "Landed tasks");
      ctx.state.parallelRan = true;
      const ci = fakeCi([green("a")]);
      expect(await barrel(ctx, ci)).toBe("waiting");
      expect(run(repo, "git", "status", "--porcelain")).toContain("retained.txt");
      expect(await answer(ctx, reply)).toBe("continue");
      const resumed = quietCtx(JSON.parse(readFileSync(join(runDir(repo, "greet"), "state.json"), "utf8")), ctx.config);
      expect(await barrel(resumed, ci)).toBe("done");
      expect(run(repo, "git", "log", "--format=%s", "master..HEAD")).toBe("Fix integration of parallel tasks");
      expect(run(repo, "git", "show", "HEAD:retained.txt")).toBe("repair");
      expect(run(repo, "git", "status", "--porcelain")).toBe("");
    });
  }

  for (const blockedStage of ["roast", "pick"]) {
    test(`BLOCKED integrated ${blockedStage} gates before review`, async () => {
      const blocked = { status: "BLOCKED", action: "choose integration behavior", ask: [{ q: "Which behavior?", rec: "compatible", opts: ["compatible", "legacy"] }] };
      const { ctx } = setupApproved([
        { match: "roast INTEGRATE", result: blockedStage === "roast" ? blocked : { status: "FAIL", action: "repair" } },
        { match: "pick INTEGRATE", result: blocked },
      ]);
      writeFileSync(ctx.state.ip, IP("approved 2026-09-27").replaceAll("- [ ]", "- [x]"));
      ctx.state.parallelRan = true;
      expect(await barrel(ctx, fakeCi([green("a")]))).toBe("waiting");
      expect(ctx.state.waiting?.task).toBe("INTEGRATE");
      expect(ctx.state.waiting?.asks[0].q).toBe("Which behavior?");
      expect(ctx.state.history.some((e) => e.stage === "review")).toBe(false);
    });
  }

  test("schedules a diamond concurrently and starts the join after both parents land", async () => {
    const { repo, ctx } = setupApproved(successfulTasks(["T1", "T2", "T3", "T4"]).map((entry) =>
      ["pick T2", "pick T3"].includes(entry.match)
        ? { ...entry, signal: entry.match, waitFor: [entry.match === "pick T2" ? "pick T3" : "pick T2"] } : entry));
    writeFileSync(ctx.state.ip, diamond);
    ctx.config.limits.parallelTasks = 2;
    // The join's setup sees the landed parent commits, including their IP marks.
    ctx.config.worktreeSetup = ["if test -f T2.txt && test -f T3.txt; then git show HEAD:docs/plans/greet.md > parents.md; fi"];
    expect(await barrel(ctx, fakeCi([green("a")]))).toBe("done");
    const events = timings(ctx);
    const at = (id: string, event: string) => events.find((e) => e.step.startsWith(`pick ${id} `) && e.event === event)!.at;
    expect(at("T2", "start")).toBeLessThan(at("T3", "end"));
    expect(at("T3", "start")).toBeLessThan(at("T2", "end"));
    expect(at("T4", "start")).toBeGreaterThanOrEqual(Math.max(at("T2", "end"), at("T3", "end")));
    expect(parseTasks(readFileSync(join(repo, "parents.md"), "utf8")).map((t) => t.done)).toEqual([true, true, true, false]);
    expect(run(repo, "git", "rev-list", "--count", "master..HEAD")).toBe("4");
    expect(parseTasks(readIp(ctx.state.ip)).every((t) => t.done)).toBe(true);
    expect(ctx.state.tasks.T2.attempts).toBe(1);
    expect(ctx.state.tasks.T3.attempts).toBe(1);
    expect(ctx.state.parallelRan).toBe(true);
    expect(run(repo, "git", "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  });

  test("never builds two ready tasks that share a file at once", async () => {
    const { repo, ctx } = setupApproved(successfulTasks(["T1", "T2", "T3"]));
    writeFileSync(ctx.state.ip, IP("approved 2026-09-27").replace(
      "- [ ] **T2** — Add farewell file",
      "- [ ] **T2** — Add farewell file\n  - Depends on: none\n  - Files: index.ts\n- [ ] **T3** — Third\n  - Depends on: none\n  - Files: index.ts",
    ));
    ctx.config.limits.parallelTasks = 3;
    expect(await barrel(ctx, fakeCi([green("a")]))).toBe("done");
    const events = timings(ctx);
    const at = (id: string, event: string) => events.find((e) => e.step.startsWith(`pick ${id} `) && e.event === event)!.at;
    const roastEnd = (id: string) => events.find((e) => e.step.startsWith(`roast ${id} `) && e.event === "end")!.at;
    expect(at("T3", "start")).toBeGreaterThanOrEqual(roastEnd("T2"));
    expect(run(repo, "git", "rev-list", "--count", "master..HEAD")).toBe("3");
  });

  test("limits a three-task ready frontier to two simultaneous builds", async () => {
    const { repo, ctx } = setupApproved(successfulTasks(["T1", "T2", "T3"]).map((entry) =>
      ["pick T1", "pick T2"].includes(entry.match)
        ? { ...entry, signal: entry.match, waitFor: [entry.match === "pick T1" ? "pick T2" : "pick T1"] } : entry));
    writeFileSync(ctx.state.ip, IP("approved 2026-09-27").replace(
      "- [ ] **T2** — Add farewell file",
      "- [ ] **T2** — Add farewell file\n  - Depends on: none\n- [ ] **T3** — Third\n  - Depends on: none",
    ));
    ctx.config.limits.parallelTasks = 2;
    expect(await barrel(ctx, fakeCi([green("a")]))).toBe("done");
    const events = timings(ctx);
    const thirdStart = events.find((e) => e.step.startsWith("pick T3 ") && e.event === "start")!.at;
    const parentEnds = events.filter((e) => /^roast T[12] /.test(e.step) && e.event === "end").map((e) => e.at);
    expect(thirdStart).toBeGreaterThanOrEqual(Math.min(...parentEnds));
    expect(run(repo, "git", "rev-list", "--count", "master..HEAD")).toBe("3");
  });

  test("CLI --parallel 1 overrides config and runs the diamond strictly in order", async () => {
    const { repo, ctx } = setupApproved([
      ...successfulTasks(["T1", "T2", "T3", "T4"]).filter((entry) => entry.match !== "brew"),
      { match: "brew", result: { status: "BLOCKED", action: "test stops before external CI" } },
    ]);
    writeFileSync(ctx.state.ip, diamond);
    saveState(ctx.state);
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "barrel", "greet", "--repo", repo, "--parallel", "1", "--no-wait"], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited).toBe(3);
    expect(err).toBe("");
    expect(out).toContain("test stops before external CI");
    const sequentialState = JSON.parse(readFileSync(join(runDir(repo, "greet"), "state.json"), "utf8"));
    expect(sequentialState.parallelRan).toBeUndefined();
    // Sequential runs still integrate: it is where e2e runs.
    expect(sequentialState.history.some((entry: { task?: string }) => entry.task === "INTEGRATE")).toBe(true);
    const events = timings(ctx);
    expect(events.filter((e) => e.step.startsWith("pick ") && e.event === "start").map((e) => e.step.split(" ")[1])).toEqual(["T1", "T2", "T3", "T4"]);
    for (let i = 1; i < 4; i++) {
      const start = events.find((e) => e.step.startsWith(`pick T${i + 1} `) && e.event === "start")!.at;
      const end = events.find((e) => e.step.startsWith(`roast T${i} `) && e.event === "end")!.at;
      expect(start).toBeGreaterThanOrEqual(end);
    }
    expect(run(repo, "git", "rev-list", "--count", "master..HEAD")).toBe("4");
  }, 60_000);

  test("rebuilds a conflicting independent task once on the new head and lands both", async () => {
    const { repo, ctx } = setupApproved([
      { match: "pick T1", sleepMs: 250, write: { "shared.txt": "one\n" }, result: { status: "PASS", action: "built" } },
      { match: "pick T2", sleepMs: 500, write: { "shared.txt": "two\n" }, result: { status: "PASS", action: "built" } },
      { match: "roast", result: { status: "PASS", action: "proven" } },
      ...successfulTasks([]),
    ]);
    writeFileSync(ctx.state.ip, IP("approved 2026-09-27").replace("- [ ] **T2** — Add farewell file", "- [ ] **T2** — Add farewell file\n  - Depends on: none"));
    ctx.config.limits.parallelTasks = 2;
    expect(await barrel(ctx, fakeCi([green("a")]))).toBe("done");
    expect(Object.values(ctx.state.tasks).map((t) => t.attempts).sort()).toEqual([1, 2]);
    const retried = Object.entries(ctx.state.tasks).find(([, t]) => t.attempts === 2)![0];
    const prompts = stepPrompts(repo, "greet", new RegExp(`-pick-${retried}-`));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("shared.txt");
    expect(prompts[1]).toContain("rebuild on the new head");
    expect(prompts[1]).toContain(`${retried === "T1" ? "T2" : "T1"} landed first and touched these`);
    expect(run(repo, "git", "rev-list", "--count", "master..HEAD")).toBe("2");
    expect(run(repo, "git", "show", `${ctx.state.tasks.T1.commit}:shared.txt`)).toBe("one");
    expect(run(repo, "git", "show", `${ctx.state.tasks.T2.commit}:shared.txt`)).toBe("two");
    expect(parseTasks(readIp(ctx.state.ip)).map((t) => t.done)).toEqual([true, true]);
    expect(run(repo, "git", "status", "--porcelain")).toBe("");
    expect(run(repo, "git", "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  });

  test("drains a running sibling after a gate without starting newly ready tasks", async () => {
    const { repo, ctx } = setupApproved([
      ...successfulTasks(["T1"]),
      { match: "pick T2", signal: "left", waitFor: ["right"], result: { status: "BLOCKED", action: "choose left behavior" } },
      ...successfulTasks(["T3"]).map((entry) => entry.match === "pick T3" ? { ...entry, signal: "right", waitForTask: { id: "T2", status: "todo" } } : entry),
    ]);
    writeFileSync(ctx.state.ip, diamond.replace("  - Depends on: T2, T3", "  - Depends on: T3"));
    ctx.config.limits.parallelTasks = 2;
    expect(await barrel(ctx, fakeCi([green("a")]))).toBe("waiting");
    expect(ctx.state.waiting?.task).toBe("T2");
    expect(ctx.state.waiting?.message).toContain("choose left behavior");
    expect(ctx.state.tasks.T3.status).toBe("passed");
    expect(readFileSync(join(repo, "T3.txt"), "utf8")).toBe("T3\n");
    expect(ctx.state.tasks.T4.status).toBe("todo");
    expect(ctx.state.history.some((entry) => entry.task === "T4")).toBe(false);
    expect(ctx.state.phase).toBe("build");
    expect(parseTasks(readIp(ctx.state.ip)).map((t) => t.done)).toEqual([true, false, true, false]);
  });

  test("preserves the first gate and resets later gated siblings to todo", async () => {
    const { repo, ctx } = setupApproved([
      ...successfulTasks(["T1"]),
      { match: "pick T2", signal: "left", waitFor: ["right"], result: { status: "BLOCKED", action: "first choice" } },
      { match: "pick T3", signal: "right", waitForTask: { id: "T2", status: "todo" }, write: { "discard.txt": "partial\n" }, result: { status: "BLOCKED", action: "second choice" } },
    ]);
    writeFileSync(ctx.state.ip, diamond);
    ctx.config.limits.parallelTasks = 2;
    expect(await barrel(ctx, fakeCi([green("a")]))).toBe("waiting");
    expect(ctx.state.waiting?.task).toBe("T2");
    expect(ctx.state.waiting?.message).toContain("first choice");
    expect(ctx.state.tasks.T3.status).toBe("todo");
    expect(ctx.state.tasks.T3.worktree).toBeUndefined();
    expect(existsSync(join(runDir(repo, "greet"), "worktrees", "T3"))).toBe(false);
    expect(existsSync(join(repo, "discard.txt"))).toBe(false);
    expect(ctx.lines.filter((line) => line.startsWith("Waiting. Answer with:"))).toHaveLength(1);
  });

  test("cleans an interrupted running task and discards its partial commit on resume", async () => {
    const { repo, ctx } = setupApproved(successfulTasks(["T1", "T2"]));
    run(repo, "git", "add", "docs/plans/greet.md");
    run(repo, "git", "commit", "-m", "Approved plan");
    run(repo, "git", "checkout", "-b", "greet");
    const tree = join(runDir(repo, "greet"), "worktrees", "T1");
    run(repo, "git", "worktree", "add", "-b", "brewery/greet/T1", tree, "HEAD");
    writeFileSync(join(tree, "partial.txt"), "discard this\n");
    run(tree, "git", "add", "partial.txt");
    run(tree, "git", "commit", "-m", "Interrupted partial work");
    ctx.state.phase = "build";
    ctx.state.branch = "greet";
    ctx.state.tasks.T1 = { status: "running", attempts: 1, worktree: tree, branch: "brewery/greet/T1", commit: run(tree, "git", "rev-parse", "HEAD") };
    saveState(ctx.state);
    expect(await barrel(ctx, fakeCi([green("a")]))).toBe("done");
    expect(existsSync(join(repo, "partial.txt"))).toBe(false);
    expect(ctx.state.tasks.T1.attempts).toBe(2);
    expect(ctx.state.tasks.T1.status).toBe("passed");
    expect(ctx.state.tasks.T1.worktree).toBeUndefined();
    expect(stepPrompts(repo, "greet", /-pick-T1-/)[0]).toContain("Interrupted build");
    expect(run(repo, "git", "log", "--format=%s", "master..HEAD").split("\n")).toEqual(["Add farewell file", "Add greeting file"]);
    expect(run(repo, "git", "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  });

  test.each([[false, false], [true, false], [true, true]])("restores the approved IP after a preflight landing failure (tracked IP=%s, tracked collision=%s)", async (tracked, trackedCollision) => {
    const repo = tempRepo();
    const ip = join(repo, "docs/plans/greet.md");
    mkdirSync(join(repo, "docs/plans"), { recursive: true });
    writeFileSync(ip, IP("approved 2026-09-27"));
    if (tracked) {
      writeFileSync(ip, IP("draft"));
      run(repo, "git", "add", "docs/plans/greet.md");
      run(repo, "git", "commit", "-m", "Draft plan");
      writeFileSync(ip, IP("approved 2026-09-27"));
      run(repo, "git", "add", "docs/plans/greet.md");
    }
    if (trackedCollision) {
      run(repo, "git", "restore", "--staged", "docs/plans/greet.md");
      writeFileSync(join(repo, "collision.txt"), "baseline\n");
      run(repo, "git", "add", "collision.txt");
      run(repo, "git", "commit", "-m", "Baseline collision");
      run(repo, "git", "add", "docs/plans/greet.md");
    }
    const tree = join(runDir(repo, "greet"), "worktrees", "T1");
    const { config } = fakeSetup(repo, [
      { match: "pick T1", write: { "collision.txt": "task output\n" }, result: { status: "PASS", action: "built" } },
      { match: "roast T1", write: { [relative(tree, join(repo, "collision.txt"))]: "keep external file\n" }, result: { status: "PASS", action: "proven" } },
    ]);
    const ctx = quietCtx(newState({ slug: "greet", repo, ip, base: "master", phase: "approved" }), config);
    await expect(barrel(ctx, fakeCi([green("a")]))).rejects.toThrow(trackedCollision ? "uncommitted changes" : "would be overwritten");
    expect(readIp(ip)).toBe(IP("approved 2026-09-27"));
    expect(readFileSync(join(repo, "collision.txt"), "utf8")).toBe("keep external file\n");
    expect(ctx.state.landing).toBeUndefined();
    expect(run(repo, "git", "log", "--format=%s", "master..HEAD")).toBe("");
    if (tracked) expect(run(repo, "git", "diff", "--cached")).toContain("approved 2026-09-27");
  });

  test("rolls back an interrupted cherry-pick before rebuilding a running task", async () => {
    const { repo, ctx } = setupApproved(successfulTasks(["T1", "T2"]));
    run(repo, "git", "add", "docs/plans/greet.md");
    run(repo, "git", "commit", "-m", "Approved plan");
    run(repo, "git", "checkout", "-b", "greet");
    const before = run(repo, "git", "rev-parse", "HEAD");
    const tree = join(runDir(repo, "greet"), "worktrees", "T1");
    run(repo, "git", "worktree", "add", "-b", "brewery/greet/T1", tree, "HEAD");
    writeFileSync(join(tree, "T1.txt"), "T1\n");
    writeFileSync(join(tree, "partial.txt"), "discard transaction\n");
    run(tree, "git", "add", "-A");
    run(tree, "git", "commit", "-m", "Unfinished landing");
    const commit = run(tree, "git", "rev-parse", "HEAD");
    run(repo, "git", "cherry-pick", commit);
    ctx.state.phase = "build";
    ctx.state.branch = "greet";
    ctx.state.tasks.T1 = { status: "running", attempts: 1, worktree: tree, branch: "brewery/greet/T1", commit };
    ctx.state.landing = { task: "T1", head: before, ip: readIp(ctx.state.ip) };
    saveState(ctx.state);
    expect(await barrel(ctx, fakeCi([green("a")]))).toBe("done");
    expect(ctx.state.landing).toBeUndefined();
    expect(existsSync(join(repo, "partial.txt"))).toBe(false);
    expect(ctx.state.tasks.T1.attempts).toBe(2);
    expect(run(repo, "git", "log", "--format=%s", "master..HEAD").split("\n")).toEqual(["Add farewell file", "Add greeting file"]);
    expect(parseTasks(readIp(ctx.state.ip)).every((task) => task.done)).toBe(true);
  });

  test("status reports running tasks and invalid parallel overrides fail clearly", async () => {
    const { repo, ctx } = setupApproved([]);
    ctx.state.tasks = { T2: { status: "running", attempts: 1 }, T3: { status: "running", attempts: 1 } };
    saveState(ctx.state);
    const cli = join(import.meta.dir, "../src/cli.ts");
    const status = Bun.spawnSync(["bun", cli, "status", "greet"], { cwd: repo, env: { ...process.env } });
    expect(status.exitCode).toBe(0);
    expect(status.stdout.toString()).toContain("running T2, T3");
    for (const value of ["", "0", "-1", "1.5", "nope", "9007199254740992"]) {
      const proc = Bun.spawnSync(["bun", cli, "barrel", "greet", "--repo", repo, "--parallel", ...(value ? [value] : []), "--no-wait"], { env: { ...process.env } });
      expect(proc.exitCode).toBe(1);
      expect(proc.stderr.toString()).toContain("--parallel needs a positive integer");
    }
  });

  test("builds every task with a separate roast, amends retries, and finishes green", async () => {
    const { repo, ctx } = setupApproved([
      { match: "pick T1", times: 1, write: { "greeting.txt": "helo\n" }, result: { status: "PASS", action: "built" } },
      { match: "roast T1", times: 1, result: { status: "FAIL", action: "fix typo", fail: [{ need: "says hello", want: "hello", got: "helo", ev: "cat greeting.txt" }] } },
      { match: "pick T1", times: 1, write: { "greeting.txt": "hello\n" }, result: { status: "PASS", action: "fixed" } },
      { match: "roast T1", result: { status: "PASS", action: "proven" } },
      { match: "pick T2", write: { "farewell.txt": "bye\n" }, result: { status: "PASS", action: "built" } },
      { match: "roast T2", result: { status: "PASS", action: "proven" } },
      { match: "roast INTEGRATE", result: { status: "PASS", action: "combined tree proven" } },
      { match: "branch review", result: { status: "PASS", action: "reviewed", findings: [] } },
      { match: "brew", result: { status: "PASS", action: "opened", pr: 7 } },
    ]);
    const ci = fakeCi([green("abc")]);

    expect(await barrel(ctx, ci)).toBe("done");

    expect(run(repo, "git", "rev-parse", "--abbrev-ref", "HEAD")).toBe("greet");
    expect(run(repo, "git", "log", "--format=%s", "master..HEAD").split("\n")).toEqual(["Add farewell file", "Add greeting file"]);
    expect(run(repo, "git", "show", "HEAD~1:greeting.txt")).toBe("hello");
    expect(run(repo, "git", "status", "--porcelain")).toBe("");
    expect(parseTasks(readIp(ctx.state.ip)).every((t) => t.done)).toBe(true);
    expect(ctx.state.phase).toBe("done");
    expect(ctx.state.pr).toBe(7);
    const stream = events(repo, "greet");
    expect(stream.filter((event) => event.kind === "step.start" && event.task === "T1").map((event) => event.stage)).toEqual(["pick", "roast", "pick", "roast"]);
    expect(stream.filter((event) => event.kind === "pr")).toEqual([expect.objectContaining({ kind: "pr", number: 7, url: "https://example.test/pr/7" })]);
    expect(stream.filter((event) => event.kind === "ci").map((event) => event.state)).toEqual(["pass"]);
    expect(stream.at(-1)).toMatchObject({ kind: "done" });

    const pickT1 = stepPrompts(repo, "greet", /-pick-T1-/);
    expect(pickT1).toHaveLength(2);
    expect(pickT1[0]).not.toContain("This is a retry");
    expect(pickT1[1]).toContain("helo");
    // roast ran as beta, a different agent from pick's alpha
    expect(ctx.state.history.filter((h) => h.stage === "roast").every((h) => h.agent === "beta")).toBe(true);
  });

  test("builds and roasts in task worktrees, then lands checked commits and removes branches", async () => {
    const { repo, ctx } = setupApproved([
      { match: "pick T1", write: { "greeting.txt": "hello\n" }, result: { status: "PASS", action: "built" } },
      { match: "roast T1", result: { status: "PASS", action: "proven" } },
      { match: "pick T2", write: { "farewell.txt": "bye\n" }, result: { status: "PASS", action: "built" } },
      { match: "roast T2", result: { status: "PASS", action: "proven" } },
      { match: "roast INTEGRATE", result: { status: "PASS", action: "combined tree proven" } },
      { match: "branch review", result: { status: "PASS", action: "ok", findings: [] } },
      { match: "brew", result: { status: "PASS", action: "opened", pr: 7 } },
    ]);
    const logFile = `${ctx.config.agents.alpha.env?.FAKE_PLAN}.calls.log`;
    ctx.config.worktreeSetup = [
      `printf ready > setup.txt; printf 'setup\\tsetup one\\t%s\\tfalse\\n' "$PWD" >> '${logFile}'`,
      `test -f setup.txt && printf 'setup\\tsetup two\\t%s\\tfalse\\n' "$PWD" >> '${logFile}'`,
    ];
    expect(await barrel(ctx, fakeCi([green("a")]))).toBe("done");
    const calls = readFileSync(`${ctx.config.agents.alpha.env?.FAKE_PLAN}.calls.log`, "utf8")
      .trim().split("\n").map((line) => line.split("\t"));
    for (const id of ["T1", "T2"]) {
      const tree = join(runDir(repo, "greet"), "worktrees", id);
      expect(calls.filter((call) => call[1].startsWith(`pick ${id}`) || call[1].startsWith(`roast ${id}`))
        .map((call) => call[2])).toEqual([tree, tree]);
      expect(calls.filter((call) => call[2] === tree).map((call) => call[1])).toEqual([
        "setup one", "setup two",
        `pick ${id} — ${id === "T1" ? "Add greeting file" : "Add farewell file"}`,
        `roast ${id} — ${id === "T1" ? "Add greeting file" : "Add farewell file"}`,
      ]);
      expect(existsSync(tree)).toBe(false);
      expect(run(repo, "git", "branch", "--list", `brewery/greet/${id}`)).toBe("");
      expect(stepPrompts(repo, "greet", new RegExp(`-pick-${id}-`))[0]).toContain(`IP at ${tree}/docs/plans/greet.md`);
      expect(stepPrompts(repo, "greet", new RegExp(`-pick-${id}-`))[0]).toContain(`run in ${tree}`);
    }
    expect(run(repo, "git", "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(parseTasks(run(repo, "git", "show", "HEAD~1:docs/plans/greet.md")).map((task) => task.done)).toEqual([true, false]);
    expect(parseTasks(run(repo, "git", "show", "HEAD:docs/plans/greet.md")).map((task) => task.done)).toEqual([true, true]);
    expect(ctx.state.tasks.T1.commit).toBe(run(repo, "git", "rev-parse", "HEAD~1"));
    expect(ctx.state.tasks.T2.commit).toBe(run(repo, "git", "rev-parse", "HEAD"));
    expect(readFileSync(join(repo, "setup.txt"), "utf8")).toBe("ready");
  });

  test("counts setup failures as attempts, preserves output, and gates without starting pick", async () => {
    const { repo, ctx } = setupApproved([]);
    ctx.config.limits.pickAttempts = 2;
    ctx.config.worktreeSetup = ["printf 'setup stdout'; printf 'setup stderr' >&2; exit 7"];
    expect(await barrel(ctx, fakeCi([green("a")]))).toBe("waiting");
    expect(ctx.state.tasks.T1.attempts).toBe(2);
    expect(ctx.state.tasks.T1.evidence).toContain("Worktree setup FAIL");
    expect(ctx.state.tasks.T1.evidence).toContain("exit 7");
    expect(ctx.state.tasks.T1.evidence).toContain("setup stdout");
    expect(ctx.state.tasks.T1.evidence).toContain("setup stderr");
    expect(ctx.state.waiting?.task).toBe("T1");
    expect(ctx.state.waiting?.message).toContain("setup stderr");
    expect(ctx.state.history).toHaveLength(0);
    expect(existsSync(join(runDir(repo, "greet"), "worktrees", "T1"))).toBe(false);
    expect(run(repo, "git", "branch", "--list", "brewery/greet/T1")).toBe("");
    expect(parseTasks(readIp(ctx.state.ip)).map((task) => task.done)).toEqual([false, false]);
    expect(run(repo, "git", "log", "--format=%s", "master..HEAD")).toBe("");
  });

  test("preserves setup evidence and gates when a locked task worktree cannot be cleaned", async () => {
    const { repo, ctx } = setupApproved([]);
    ctx.config.limits.pickAttempts = 2;
    ctx.config.worktreeSetup = ["git worktree lock --reason cleanup-test .; printf 'setup stdout'; printf 'setup stderr' >&2; exit 7"];
    const tree = join(runDir(repo, "greet"), "worktrees", "T1");
    try {
      expect(await barrel(ctx, fakeCi([green("a")]))).toBe("waiting");
      const saved = loadState("greet", repo);
      expect(saved.tasks.T1.attempts).toBe(2);
      expect(saved.tasks.T1.evidence).toContain("Worktree setup FAIL");
      expect(saved.tasks.T1.evidence).toContain("exit 7");
      expect(saved.tasks.T1.evidence).toContain("setup stdout");
      expect(saved.tasks.T1.evidence).toContain("setup stderr");
      expect(saved.waiting?.task).toBe("T1");
      expect(saved.waiting?.message).toContain("setup stderr");
      expect(saved.history).toHaveLength(0);
      expect(ctx.lines.join("\n")).toContain("cleanup");
      expect(ctx.lines.join("\n")).toContain("locked");
      expect(saved.tasks.T1.worktree).toBe(tree);
      expect(parseTasks(readIp(ctx.state.ip)).map((task) => task.done)).toEqual([false, false]);
    } finally {
      run(repo, "git", "worktree", "unlock", tree);
      run(repo, "git", "worktree", "remove", "--force", tree);
    }
  });

  test("logs failed cleanup of a skipped task while other tasks still land", async () => {
    const { repo, ctx } = setupApproved(successfulTasks(["T2"]));
    const tree = join(runDir(repo, "greet"), "worktrees", "T1");
    const branch = "brewery/greet/T1";
    run(repo, "git", "worktree", "add", "-b", branch, tree, "HEAD");
    run(repo, "git", "worktree", "lock", tree);
    ctx.state.tasks.T1 = { status: "skipped", attempts: 1, worktree: tree, branch };
    try {
      expect(await barrel(ctx, fakeCi([green("a")]))).toBe("done");
      expect(ctx.state.tasks.T1).toMatchObject({ status: "skipped", worktree: tree, branch });
      expect(ctx.state.tasks.T2.status).toBe("passed");
      expect(ctx.lines.join("\n")).toContain("cleanup failed for T1");
      expect(readFileSync(join(repo, "T2.txt"), "utf8")).toBe("T2\n");
    } finally {
      run(repo, "git", "worktree", "unlock", tree);
      run(repo, "git", "worktree", "remove", "--force", tree);
    }
  });

  test("keeps post-land cleanup strict and preserves the landed commit", async () => {
    const { repo, ctx } = setupApproved(successfulTasks(["T1", "T2"]));
    ctx.config.worktreeSetup = ["git worktree lock --reason strict-land-test ."];
    const tree = join(runDir(repo, "greet"), "worktrees", "T1");
    try {
      await expect(barrel(ctx, fakeCi([green("a")]))).rejects.toThrow("cannot remove a locked working tree");
      const saved = loadState("greet", repo);
      expect(saved.tasks.T1.status).toBe("passed");
      expect(saved.tasks.T1.commit).toBe(run(repo, "git", "rev-parse", "HEAD"));
      expect(parseTasks(readIp(ctx.state.ip)).map((task) => task.done)).toEqual([true, false]);
      expect(saved.tasks.T1.worktree).toBe(tree);
      expect(saved.history.some((entry) => entry.task === "T2")).toBe(false);
      // Resuming cannot bypass the strict post-land cleanup gate.
      await expect(barrel(ctx, fakeCi([green("a")]))).rejects.toThrow("cannot remove a locked working tree");
      expect(ctx.state.history.some((entry) => entry.task === "T2")).toBe(false);
    } finally {
      run(repo, "git", "worktree", "unlock", tree);
      run(repo, "git", "worktree", "remove", "--force", tree);
    }
  });

  for (const tracked of [true, false]) {
    test(`keeps the approved IP snapshot when ${tracked ? "tracked approval edits are restored" : "an untracked IP is removed"} during sibling landing`, async () => {
      const { repo, ctx } = setupApproved([
        { match: "pick T1", write: { "greeting.txt": "hello\n" }, result: { status: "PASS", action: "built" } },
        { match: "pick T2", write: { "farewell.txt": "bye\n" }, result: { status: "PASS", action: "built" } },
        { match: "roast", result: { status: "PASS", action: "proven" } },
        { match: "review", result: { status: "PASS", action: "reviewed" } },
        { match: "brew", result: { status: "PASS", action: "opened", pr: 7 } },
      ]);
      const approved = IP("approved 2026-09-27")
        .replace("A text file.", "A text file with an approved specification.")
        .replace("- [ ] **T2** — Add farewell file", "- [ ] **T2** — Add farewell file\n  - Depends on: none");
      if (tracked) {
        writeFileSync(ctx.state.ip, IP("draft"));
        run(repo, "git", "add", "docs/plans/greet.md");
        run(repo, "git", "commit", "-m", "Draft plan");
      }
      writeFileSync(ctx.state.ip, approved);
      ctx.config.limits.parallelTasks = 2;
      const tree = join(runDir(repo, "greet"), "worktrees", "T2");
      const landing = join(runDir(repo, "greet"), "landing-started");
      const copied = join(runDir(repo, "greet"), "snapshot-copied");
      const spawn = Bun.spawn;
      const snapshots: string[] = [];
      let transientIp: string | undefined;
      let overlap = false;
      // Delay real OS commands at a rendezvous, keeping Git and agents real.
      // Positional arguments avoid interpolating paths or commands into shell code.
      const waitForSignal = 'for ((i=0; i<500; i++)); do if test -f "$1"; then shift; exec "$@"; fi; sleep 0.01; done; exit 70';
      const spy = spyOn(Bun, "spawn").mockImplementation(((argv: string[], options: { cwd?: string }) => {
        if (options.cwd === repo && argv[0] === "git" && argv[1] === "worktree" && argv[2] === "add" && argv.includes(tree)) {
          return spawn(["bash", "-c", waitForSignal, "wait-for-landing", landing, ...argv], options as Parameters<typeof spawn>[1]);
        }
        if (options.cwd === repo && argv[0] === "git" && argv[1] === "cherry-pick" && !argv[2].startsWith("--") && !existsSync(landing)) {
          writeFileSync(landing, "started");
          return spawn(["bash", "-c", waitForSignal, "wait-for-snapshot", copied, ...argv], options as Parameters<typeof spawn>[1]);
        }
        if (options.cwd === tree && argv[0] === "bun") {
          snapshots.push(readIp(join(tree, "docs/plans/greet.md")));
          if (!existsSync(copied)) {
            overlap = true;
            transientIp = existsSync(ctx.state.ip) ? readIp(ctx.state.ip) : undefined;
            writeFileSync(copied, "copied");
          }
        }
        return spawn(argv, options as Parameters<typeof spawn>[1]);
      }) as typeof Bun.spawn);
      try {
        expect(await barrel(ctx, fakeCi([green("a")]))).toBe("done");
        expect(overlap).toBe(true);
        if (tracked) expect(transientIp).toBe(IP("draft"));
        else expect(transientIp).toBeUndefined();
        // Both Pick and Roast must receive the exact approved text.
        expect(snapshots).toEqual([approved, approved]);
        expect(ctx.state.tasks.T1.status).toBe("passed");
        expect(ctx.state.tasks.T2.status).toBe("passed");
        expect(parseTasks(readIp(ctx.state.ip)).map((task) => task.done)).toEqual([true, true]);
        expect(readIp(ctx.state.ip)).toContain("approved specification");
        expect(run(repo, "git", "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });
  }

  test("uses tracked approval edits in the worktree and lands them with the task", async () => {
    const { repo, ctx } = setupApproved([
      { match: "pick T1", write: { "greeting.txt": "hello\n" }, result: { status: "PASS", action: "built" } },
      { match: "roast T1", result: { status: "PASS", action: "proven" } },
      { match: "pick T2", result: { status: "BLOCKED", action: "pause" } },
    ]);
    writeFileSync(ctx.state.ip, IP("draft"));
    run(repo, "git", "add", "docs/plans/greet.md");
    run(repo, "git", "commit", "-m", "Draft plan");
    writeFileSync(ctx.state.ip, IP("approved 2026-09-27").replace("A text file.", "A text file with an approved specification."));
    // Both staged and unstaged IP edits are allowed by ensureBranch.
    run(repo, "git", "add", "docs/plans/greet.md");
    expect(await barrel(ctx, fakeCi([green("a")]))).toBe("waiting");
    const landed = run(repo, "git", "show", "HEAD:docs/plans/greet.md");
    expect(readStatus(landed)).toBe("approved 2026-09-27");
    expect(landed).toContain("approved specification");
    expect(parseTasks(landed).map((task) => task.done)).toEqual([true, false]);
  });

  test("retains a gated task's implementation for retry and still lands one commit", async () => {
    const { repo, ctx } = setupApproved([
      { match: "pick T1", times: 1, write: { "greeting.txt": "helo\n", "retained.txt": "keep\n" }, result: { status: "PASS", action: "built" } },
      { match: "roast T1", times: 1, result: { status: "FAIL", action: "fix typo" } },
      { match: "pick T1", write: { "greeting.txt": "hello\n" }, result: { status: "PASS", action: "fixed" } },
      { match: "roast T1", result: { status: "PASS", action: "proven" } },
      { match: "pick T2", result: { status: "BLOCKED", action: "pause" } },
    ]);
    ctx.config.limits.pickAttempts = 1;
    expect(await barrel(ctx, fakeCi([green("a")]))).toBe("waiting");
    const tree = join(runDir(repo, "greet"), "worktrees", "T1");
    expect(existsSync(join(tree, "retained.txt"))).toBe(true);
    expect(ctx.state.tasks.T1.commit).toBe(run(tree, "git", "rev-parse", "HEAD"));
    expect(await answer(ctx, "retry: fix the typo")).toBe("continue");
    expect(await barrel(ctx, fakeCi([green("a")]))).toBe("waiting");
    expect(readFileSync(join(repo, "retained.txt"), "utf8")).toBe("keep\n");
    expect(readFileSync(join(repo, "greeting.txt"), "utf8")).toBe("hello\n");
    expect(run(repo, "git", "log", "--format=%s", "master..HEAD")).toBe("Add greeting file");
    expect(existsSync(tree)).toBe(false);
  });

  test("refuses an IP that is not approved", async () => {
    const { repo, ctx } = setupApproved([]);
    writeFileSync(ctx.state.ip, IP("awaiting sign-off"));
    await expect(barrel(ctx, fakeCi([green("a")]))).rejects.toThrow("not approved");
    saveState(ctx.state);
    const command = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), "barrel", "greet", "--repo", repo], { cwd: repo, env: process.env });
    expect(command.exitCode).toBe(1);
    expect(events(repo, "greet").at(-1)).toMatchObject({ kind: "error", message: expect.stringContaining("not approved") });
  });

  test("gates a task after the attempt limit, and 'skip' moves past it", async () => {
    const { ctx } = setupApproved([
      { match: "pick T1", result: { status: "FAIL", action: "cannot", fail: [{ need: "x", want: "y", got: "z", ev: "e" }] } },
      { match: "pick T2", write: { "farewell.txt": "bye\n" }, result: { status: "PASS", action: "built" } },
      { match: "roast T2", result: { status: "PASS", action: "proven" } },
      { match: "roast INTEGRATE", result: { status: "PASS", action: "combined tree proven" } },
      { match: "branch review", result: { status: "PASS", action: "ok", findings: [] } },
      { match: "brew", result: { status: "PASS", action: "opened", pr: 7 } },
    ]);
    ctx.config.limits.pickAttempts = 2;
    expect(await barrel(ctx, fakeCi([green("a")]))).toBe("waiting");
    expect(ctx.state.waiting?.task).toBe("T1");
    expect(events(ctx.state.repo, "greet").at(-1)).toMatchObject({ kind: "waiting", waitingKind: "gate" });
    expect(await answer(ctx, "skip")).toBe("continue");
    expect(await barrel(ctx, fakeCi([green("a")]))).toBe("done");
    expect(ctx.state.tasks.T1.status).toBe("skipped");
  });
});

describe("barrel test-first", () => {
  const RED = 'test "$(cat greeting.txt 2>/dev/null)" = hello\n';
  const oneTask = IP("approved 2026-09-27").replace("- [ ] **T2** — Add farewell file\n", "");
  const wroteTests = { status: "PASS", action: "wrote the tests", tests: ["greeting.test.sh"], command: "sh greeting.test.sh" };
  const after = [
    { match: "roast INTEGRATE", result: { status: "PASS", action: "combined tree proven" } },
    { match: "branch review", result: { status: "PASS", action: "reviewed", findings: [] } },
    { match: "brew", result: { status: "PASS", action: "opened", pr: 7 } },
  ];
  const setup = (plan: unknown[], configure: (config: ReturnType<typeof quietCtx>["config"]) => void = () => {}): { repo: string; ctx: ReturnType<typeof quietCtx> } => {
    const repo = tempRepo();
    mkdirSync(join(repo, "docs/plans"), { recursive: true });
    writeFileSync(join(repo, "docs/plans/greet.md"), oneTask);
    const { config } = fakeSetup(repo, [...plan, ...after], { roast: ["beta"] });
    config.limits.testFirst = true;
    configure(config);
    const state = newState({ slug: "greet", repo, ip: join(repo, "docs/plans/greet.md"), base: "master", phase: "approved" });
    return { repo, ctx: quietCtx(state, config) };
  };
  const stagesFor = (repo: string, task: string): unknown[] =>
    events(repo, "greet").filter((event) => event.kind === "step.start" && event.task === task).map((event) => event.stage);

  test("writes the task's tests first, confirms them red, and lands tests and code in one commit", async () => {
    const { repo, ctx } = setup([
      { match: "test T1", write: { "greeting.test.sh": RED }, result: wroteTests },
      { match: "pick T1", write: { "greeting.txt": "hello\n" }, result: { status: "PASS", action: "built" } },
      { match: "roast T1", result: { status: "PASS", action: "proven" } },
    ]);

    expect(await barrel(ctx, fakeCi([green("abc")]))).toBe("done");

    expect(stagesFor(repo, "T1")).toEqual(["test", "pick", "roast"]);
    expect(run(repo, "git", "log", "--format=%s", "master..HEAD").split("\n")).toEqual(["Add greeting file"]);
    expect(run(repo, "git", "show", "--name-only", "--format=", "HEAD").split("\n")).toEqual(expect.arrayContaining(["greeting.test.sh", "greeting.txt"]));
    const [testPrompt] = stepPrompts(repo, "greet", /-test-T1-/);
    expect(testPrompt).toContain("barrel/stages/test.md");
    const [pickPrompt] = stepPrompts(repo, "greet", /-pick-T1-/);
    expect(pickPrompt).toContain("greeting.test.sh");
    expect(pickPrompt).toContain("sh greeting.test.sh");
    const [roastPrompt] = stepPrompts(repo, "greet", /-roast-T1-/);
    expect(roastPrompt).toContain("greeting.test.sh");
  });

  test("rejects tests that already pass before any implementation", async () => {
    const { repo, ctx } = setup([
      { match: "test T1", times: 1, write: { "greeting.test.sh": "true\n" }, result: wroteTests },
      { match: "test T1", write: { "greeting.test.sh": RED }, result: wroteTests },
      { match: "pick T1", write: { "greeting.txt": "hello\n" }, result: { status: "PASS", action: "built" } },
      { match: "roast T1", result: { status: "PASS", action: "proven" } },
    ]);

    expect(await barrel(ctx, fakeCi([green("abc")]))).toBe("done");

    expect(stagesFor(repo, "T1")).toEqual(["test", "test", "pick", "roast"]);
    expect(stepPrompts(repo, "greet", /-test-T1-/)[1]).toContain("passed before any implementation");
  });

  test("rejects a test step that edits files it did not declare, and reverts them", async () => {
    const { repo, ctx } = setup([
      { match: "test T1", times: 1, write: { "greeting.test.sh": RED, "greeting.txt": "hello\n" }, result: wroteTests },
      { match: "test T1", write: { "greeting.test.sh": RED }, result: wroteTests },
      { match: "pick T1", write: { "greeting.txt": "hello\n" }, result: { status: "PASS", action: "built" } },
      { match: "roast T1", result: { status: "PASS", action: "proven" } },
    ]);

    expect(await barrel(ctx, fakeCi([green("abc")]))).toBe("done");

    expect(stagesFor(repo, "T1")).toEqual(["test", "test", "pick", "roast"]);
    const retry = stepPrompts(repo, "greet", /-test-T1-/)[1];
    expect(retry).toContain("greeting.txt");
    expect(retry).toContain("not declared");
  });

  test("runs the tests itself after pick and retries a pick that leaves them red", async () => {
    const { repo, ctx } = setup([
      { match: "test T1", write: { "greeting.test.sh": RED }, result: wroteTests },
      { match: "pick T1", times: 1, write: { "greeting.txt": "helo\n" }, result: { status: "PASS", action: "built" } },
      { match: "pick T1", write: { "greeting.txt": "hello\n" }, result: { status: "PASS", action: "fixed" } },
      { match: "roast T1", result: { status: "PASS", action: "proven" } },
    ]);

    expect(await barrel(ctx, fakeCi([green("abc")]))).toBe("done");

    expect(stagesFor(repo, "T1")).toEqual(["test", "pick", "pick", "roast"]);
    expect(stepPrompts(repo, "greet", /-pick-T1-/)[1]).toContain("still fail");
    expect(run(repo, "git", "show", "HEAD:greeting.txt")).toBe("hello");
  });

  test("a pick that changes the tests must say why, and roast sees the reason", async () => {
    const { repo, ctx } = setup([
      { match: "test T1", write: { "greeting.test.sh": RED }, result: wroteTests },
      { match: "pick T1", times: 1, write: { "greeting.txt": "hello\n", "greeting.test.sh": "true\n" }, result: { status: "PASS", action: "built" } },
      {
        match: "pick T1", write: { "greeting.test.sh": "grep -qx hello greeting.txt\n" },
        result: { status: "PASS", action: "fixed", testChanges: [{ file: "greeting.test.sh", why: "match the whole line instead of comparing cat output" }] },
      },
      { match: "roast T1", result: { status: "PASS", action: "proven" } },
    ]);

    expect(await barrel(ctx, fakeCi([green("abc")]))).toBe("done");

    expect(stagesFor(repo, "T1")).toEqual(["test", "pick", "pick", "roast"]);
    expect(stepPrompts(repo, "greet", /-pick-T1-/)[1]).toContain("changed the tests without saying why");
    expect(stepPrompts(repo, "greet", /-roast-T1-/)[0]).toContain("match the whole line instead of comparing cat output");
  });

  test("roast can send a task back to the test step, which then need not be red", async () => {
    const { repo, ctx } = setup([
      { match: "test T1", times: 1, write: { "greeting.test.sh": RED }, result: wroteTests },
      { match: "pick T1", times: 1, write: { "greeting.txt": "hello\n" }, result: { status: "PASS", action: "built" } },
      { match: "roast T1", times: 1, result: { status: "FAIL", action: "add the empty-file case", retest: true, fail: [{ need: "empty file case", want: "a test", got: "none", ev: "greeting.test.sh" }] } },
      { match: "test T1", write: { "empty.test.sh": "test -s greeting.txt\n" }, result: { status: "PASS", action: "added", tests: ["greeting.test.sh", "empty.test.sh"], command: "sh greeting.test.sh && sh empty.test.sh" } },
      { match: "pick T1", result: { status: "PASS", action: "already green" } },
      { match: "roast T1", result: { status: "PASS", action: "proven" } },
    ]);

    expect(await barrel(ctx, fakeCi([green("abc")]))).toBe("done");

    expect(stagesFor(repo, "T1")).toEqual(["test", "pick", "roast", "test", "pick", "roast"]);
    expect(stepPrompts(repo, "greet", /-test-T1-/)[1]).toContain("add the empty-file case");
    expect(run(repo, "git", "show", "--name-only", "--format=", "HEAD").split("\n")).toContain("empty.test.sh");
  });

  test("an untestable task skips the red check and roast is told why", async () => {
    const { repo, ctx } = setup([
      { match: "test T1", result: { status: "PASS", action: "nothing to test", tests: [], untestable: "the task only adds prose to the README" } },
      { match: "pick T1", write: { "greeting.txt": "hello\n" }, result: { status: "PASS", action: "built" } },
      { match: "roast T1", result: { status: "PASS", action: "proven" } },
    ]);

    expect(await barrel(ctx, fakeCi([green("abc")]))).toBe("done");

    expect(stagesFor(repo, "T1")).toEqual(["test", "pick", "roast"]);
    expect(stepPrompts(repo, "greet", /-roast-T1-/)[0]).toContain("the task only adds prose to the README");
  });

  test("an escalation agent that is not installed falls back to the stage's own agents", async () => {
    const { ctx } = setup([
      { match: "test T1", times: 1, write: { "greeting.test.sh": "true\n" }, result: wroteTests },
      { match: "test T1", write: { "greeting.test.sh": RED }, result: wroteTests },
      { match: "pick T1", write: { "greeting.txt": "hello\n" }, result: { status: "PASS", action: "built" } },
      { match: "roast T1", result: { status: "PASS", action: "proven" } },
    ], (config) => {
      config.agents.missing = { type: "command", command: ["brewery-no-such-agent"] };
      config.escalate = { test: ["missing"] };
      config.limits.escalateAfter = 1;
    });

    expect(await barrel(ctx, fakeCi([green("abc")]))).toBe("done");

    expect(ctx.state.history.filter((h) => h.stage === "test").map((h) => h.agent)).toEqual(["alpha", "alpha"]);
    expect(ctx.lines.some((line) => line.includes("no escalation agent available for test"))).toBe(true);
    expect(ctx.state.reroutes).toEqual([
      expect.stringMatching(/^test: missing skipped \(/),
      "test: escalation to missing unavailable, fell back to its normal route",
    ]);
    const [brew] = stepPrompts(ctx.state.repo, ctx.state.slug, /-brew-/);
    expect(brew).toContain("- Tests-first writer: alpha (model unknown)");
    expect(brew).toContain("- Rerouted or fell back: test: missing skipped (");
  });

  test("runs the repo's terreno-test-hygiene on the new tests and rejects violations", async () => {
    // A stand-in for @terreno/test's bin: exit 1 naming the rule when a file sleeps.
    const hygiene = '#!/bin/sh\nif grep -l "Bun.sleep" "$@"; then echo "no-sleep: use waitUntil"; exit 1; fi\n';
    const { repo, ctx } = setup([
      { match: "test T1", times: 1, write: { "greeting.test.ts": "await Bun.sleep(100);\n" }, result: { ...wroteTests, tests: ["greeting.test.ts"], command: "test -f greeting.txt" } },
      { match: "test T1", write: { "greeting.test.ts": "expect(read()).toBe(\"hello\");\n" }, result: { ...wroteTests, tests: ["greeting.test.ts"], command: "test -f greeting.txt" } },
      { match: "pick T1", write: { "greeting.txt": "hello\n" }, result: { status: "PASS", action: "built" } },
      { match: "roast T1", result: { status: "PASS", action: "proven" } },
    ], (config) => {
      config.worktreeSetup = [`mkdir -p node_modules/.bin && printf '%b' '${hygiene.replace(/\n/g, "\\n")}' > node_modules/.bin/terreno-test-hygiene && chmod +x node_modules/.bin/terreno-test-hygiene`];
    });
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    run(repo, "git", "add", ".gitignore");
    run(repo, "git", "commit", "-q", "-m", "Ignore node_modules");

    expect(await barrel(ctx, fakeCi([green("abc")]))).toBe("done");

    expect(stagesFor(repo, "T1")).toEqual(["test", "test", "pick", "roast"]);
    expect(stepPrompts(repo, "greet", /-test-T1-/)[1]).toContain("no-sleep: use waitUntil");
  });

  test("escalates the test step and pick to the escalation agents after escalateAfter runs", async () => {
    const { ctx } = setup([
      { match: "test T1", agent: "alpha", write: { "greeting.test.sh": "true\n" }, result: wroteTests },
      { match: "test T1", agent: "beta", write: { "greeting.test.sh": RED }, result: wroteTests },
      { match: "pick T1", agent: "alpha", write: { "greeting.txt": "helo\n" }, result: { status: "PASS", action: "built" } },
      { match: "pick T1", agent: "beta", write: { "greeting.txt": "hello\n" }, result: { status: "PASS", action: "fixed" } },
      { match: "roast T1", result: { status: "PASS", action: "proven" } },
    ], (config) => {
      config.escalate = { test: ["beta"], pick: ["beta"] };
      config.limits.escalateAfter = 1;
    });

    expect(await barrel(ctx, fakeCi([green("abc")]))).toBe("done");

    const agents = (stage: string) => ctx.state.history.filter((h) => h.stage === stage).map((h) => h.agent);
    expect(agents("test")).toEqual(["alpha", "beta"]);
    expect(agents("pick")).toEqual(["alpha", "beta"]);
    expect(ctx.lines.some((line) => line.includes("escalating test T1 to beta"))).toBe(true);
  });
});

describe("pour (one shot)", () => {
  const draft = (text: string, asks: unknown[] = []) => [
    { match: "distill (write the IP)", write: { "docs/plans/greet.md": text }, result: { status: "PASS", action: "drafted", ip: "docs/plans/greet.md", ask: asks } },
    { match: "cut", result: { status: "PASS", action: "attacked", findings: [] } },
  ];
  const build = [
    { match: "test T", result: { status: "PASS", action: "nothing to test", tests: [], untestable: "a fixture task" } },
    { match: "pick T1", write: { "greeting.txt": "hello\n" }, result: { status: "PASS", action: "built" } },
    { match: "pick T2", write: { "farewell.txt": "bye\n" }, result: { status: "PASS", action: "built" } },
    { match: "roast T", result: { status: "PASS", action: "proven" } },
    { match: "roast INTEGRATE", result: { status: "PASS", action: "combined tree proven" } },
    { match: "branch review", result: { status: "PASS", action: "reviewed", findings: [] } },
    { match: "brew", result: { status: "PASS", action: "opened", pr: 7 } },
  ];
  const setup = (plan: unknown[], configure: (config: ReturnType<typeof quietCtx>["config"]) => void = () => {}) => {
    const repo = tempRepo();
    const { config } = fakeSetup(repo, plan);
    config.limits.testFirst = true;
    configure(config);
    const state = newState({ slug: "greet", repo, ip: join(repo, "docs/plans/2026-09-27-greet.md"), base: "master", phase: "distill" });
    return { repo, ctx: quietCtx(state, config) };
  };

  test("approves a small plan with no fundamental questions and builds it to a green PR", async () => {
    const deferrable = { q: "Plain text or markdown?", rec: "Plain text", opts: ["Plain text", "Markdown"] };
    const { repo, ctx } = setup([...draft(IP("draft"), [deferrable]), ...build]);

    expect(await pour(ctx, "Add a greeting file.")).toBe("approved");
    expect(readStatus(readIp(ctx.state.ip))).toStartWith("approved");
    expect(readStatus(readIp(ctx.state.ip))).toContain("pour");
    expect(ctx.state.waiting).toBeUndefined();
    expect(await barrel(ctx, fakeCi([green("abc")]))).toBe("done");

    expect(run(repo, "git", "log", "--format=%s", "master..HEAD").split("\n")).toEqual(["Add farewell file", "Add greeting file"]);
    expect(stepPrompts(repo, "greet", /-distill-/)[0]).toContain('"fundamental": true');
  });

  test("stops for the human when the plan has a fundamental question", async () => {
    const fundamental = { q: "Who sees the greeting?", rec: "Everyone", opts: ["Everyone", "Staff only"], fundamental: true };
    const { ctx } = setup(draft(IP("draft"), [fundamental]));

    expect(await pour(ctx, "Add a greeting file.")).toBe("waiting");
    expect(ctx.state.waiting?.kind).toBe("signoff");
    expect(ctx.state.waiting?.message).toContain("Who sees the greeting?");
    expect(readStatus(readIp(ctx.state.ip))).toStartWith("awaiting sign-off");
  });

  test("stops for the human when the plan is too big for one shot", async () => {
    const { ctx } = setup(draft(IP("draft")), (config) => {
      config.limits.pourMaxTasks = 1;
    });

    expect(await pour(ctx, "Add a greeting file.")).toBe("waiting");
    expect(ctx.state.waiting?.message).toContain("2 tasks");
  });
});

describe("finish", () => {
  test("records a pending CI snapshot before the green result", async () => {
    const repo = tempRepo();
    const { config } = fakeSetup(repo, []);
    const ctx = quietCtx(newState({ slug: "pr-7", repo, ip: "", base: "master", phase: "finish" }), config);
    expect(await finish(ctx, fakeCi([pending("a"), green("a")]), 7)).toBe("done");
    expect(events(repo, "pr-7").map((event) => event.kind)).toEqual(["pr", "ci", "ci", "done"]);
    expect(events(repo, "pr-7").filter((event) => event.kind === "ci").map((event) => event.state)).toEqual(["pending", "pass"]);
  });

  test("reacts to a red head, counts the push, and stops when green", async () => {
    const repo = tempRepo();
    const { config } = fakeSetup(repo, [{ match: "taste", result: { status: "PASS", action: "fixed and pushed", sha: "b" } }]);
    const ctx = quietCtx(newState({ slug: "pr-7", repo, ip: "", base: "master", phase: "finish" }), config);
    const ci = fakeCi([red("a"), green("b"), green("b")]);
    expect(await finish(ctx, ci, 7)).toBe("done");
    expect(ctx.state.finish?.pushes).toBe(1);
    expect(ctx.state.history.filter((h) => h.stage === "taste")).toHaveLength(1);
  });

  test("reacts to an unanswered bot thread on a green head instead of finishing", async () => {
    const repo = tempRepo();
    const { config } = fakeSetup(repo, [{ match: "taste", result: { status: "PASS", action: "replied and resolved" } }]);
    const ctx = quietCtx(newState({ slug: "pr-7", repo, ip: "", base: "master", phase: "finish" }), config);
    const withThread = { ...green("a"), botThreads: [{ id: "T1", author: "cursor", path: "a.ts", line: 3, body: "Possible null deref" }] };
    expect(await finish(ctx, fakeCi([withThread, green("a")]), 7)).toBe("done");
    expect(ctx.state.history.filter((h) => h.stage === "taste")).toHaveLength(1);
  });

  test("escalates after three fix rounds that leave the PR red", async () => {
    const repo = tempRepo();
    const { config } = fakeSetup(repo, [{ match: "taste", result: { status: "PASS", action: "pushed a fix" } }]);
    const ctx = quietCtx(newState({ slug: "pr-7", repo, ip: "", base: "master", phase: "finish" }), config);
    const redFail = (sha: string, name: string): PrSnapshot => ({ ...red(sha), checks: [{ name, bucket: "fail" }] });
    const ci = fakeCi([redFail("a", "t1"), redFail("b", "t2"), redFail("b", "t2"), redFail("c", "t3"), redFail("c", "t3"), redFail("d", "t4"), redFail("d", "t4"), redFail("e", "t5")]);
    expect(await finish(ctx, ci, 7)).toBe("waiting");
    expect(ctx.state.waiting?.kind).toBe("gate");
    expect(ctx.state.waiting?.asks[0]?.q).toContain("BLOCKED — PR #7 still red after 3 fix rounds");
    expect(ctx.state.history.filter((h) => h.stage === "taste")).toHaveLength(3);
  });

  test("gates when the same failure survives two reactions", async () => {
    const repo = tempRepo();
    const { config } = fakeSetup(repo, [{ match: "taste", result: { status: "PASS", action: "reran" } }]);
    const ctx = quietCtx(newState({ slug: "pr-7", repo, ip: "", base: "master", phase: "finish" }), config);
    expect(await finish(ctx, fakeCi([red("a")]), 7)).toBe("waiting");
    expect(ctx.state.waiting?.kind).toBe("gate");
    expect(events(repo, "pr-7").filter((event) => event.kind === "ci").map((event) => event.state)).toEqual(["fail", "fail", "fail"]);
    expect(ctx.state.history.filter((h) => h.stage === "taste")).toHaveLength(2);
  });
});

test("CLI answer preserves a quoted reply beginning with flags", () => {
  const repo = tempRepo();
  fakeSetup(repo, [{ match: "", result: { status: "PASS", action: "Applied", ask: [] } }]);
  const ip = join(repo, "plan.md");
  writeFileSync(ip, IP("awaiting sign-off"));
  const state = newState({slug: "reply", repo, ip, base: "master", phase: "signoff"});
  state.waiting = {kind: "signoff", asks: [], message: "Approve?", since: new Date().toISOString()};
  saveState(state);
  const reply = "--go\nKeep 'quoted' text verbatim";
  const command = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), "answer", "reply", reply, "--repo", repo, "--no-wait"], {cwd: repo, env: process.env});
  expect(command.exitCode).toBe(3);
  expect(loadState("reply", repo).answers[0]?.a).toBe(reply);
});
