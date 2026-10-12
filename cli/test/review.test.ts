import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../src/agents.ts";
import { loadState, newState, runDir, saveState, withRunLock } from "../src/state.ts";
import { fakeSetup, IP, run, tempRepo } from "./helpers.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
const waitFor = async (check: () => boolean) => {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for child");
    await Bun.sleep(10);
  }
};

test("real CLI task commits exclude private artifacts in a fresh linked worktree", () => {
  const main = tempRepo();
  const repo = `${main}-linked`;
  run(main, "git", "worktree", "add", "-b", "linked", repo);
  const ip = join(repo, "plan.md");
  writeFileSync(ip, IP("approved"));
  fakeSetup(repo, [
    { match: "pick T1", write: { "greeting.txt": "hello", ".terreno/request.txt": "synthetic request" } },
    { match: "roast T1" },
    { match: "pick T2", result: { status: "BLOCKED", action: "stop fixture", ask: [] } },
  ]);
  saveState(newState({ slug: "linked", repo, ip, base: "master", phase: "approved" }));
  const result = Bun.spawnSync(["bun", cli, "resume", "linked", "--repo", repo, "--go", "--no-wait"], { cwd: repo, env: process.env });
  expect(result.exitCode).toBe(3);
  expect(run(repo, "git", "show", "HEAD:greeting.txt")).toBe("hello");
  expect(run(repo, "git", "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(".terreno");
  expect(Bun.spawnSync(["git", "check-ignore", "-q", ".terreno/brewery/x"], { cwd: repo }).exitCode).toBe(0);
});

test("agent invocation discards a preexisting PASS when the new agent writes no result", async () => {
  const repo = tempRepo();
  const resultFile = join(repo, "result.json");
  writeFileSync(resultFile, JSON.stringify({ status: "PASS", action: "stale" }));
  const outcome = await runAgent({ name: "fresh", profile: { type: "command", command: ["bun", "-e", "await Bun.stdin.text()"] }, cwd: repo, prompt: "test", promptFile: join(repo, "prompt"), logFile: join(repo, "log"), resultFile, timeoutMin: 1 });
  expect(outcome.result.status).toBe("FAIL");
  expect(outcome.result.fail?.[0].got).toContain("without writing");
});

test("interrupt after result creation reserves the sequence before same-stage resume", async () => {
  const repo = tempRepo();
  const ip = join(repo, "plan.md");
  writeFileSync(ip, IP("approved"));
  fakeSetup(repo, [
    { match: "pick T1", times: 1, sleepAfterResultMs: 30000 },
    { match: "pick T1", noResult: true },
  ]);
  saveState(newState({ slug: "interrupted", repo, ip, base: "master", phase: "approved" }));
  const args = ["bun", cli, "resume", "interrupted", "--repo", repo, "--go", "--no-wait"];
  const first = Bun.spawn(args, { cwd: repo, env: process.env, stdout: "ignore", stderr: "ignore" });
  const dir = runDir(repo, "interrupted");
  try {
    await waitFor(() => existsSync(join(dir, "steps/001-pick-T1-alpha.result.json")));
    first.kill("SIGKILL");
    await first.exited;
    expect(loadState("interrupted", repo).seq).toBe(1);
    const resumed = Bun.spawnSync(args, { cwd: repo, env: process.env });
    expect(resumed.exitCode).toBe(3);
    const state = loadState("interrupted", repo);
    expect(state.history.length).toBeGreaterThan(0);
    expect(state.history.every((entry) => entry.status === "FAIL")).toBe(true);
    const starts = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((e) => e.kind === "step.start");
    expect(new Set(starts.map((e) => e.seq)).size).toBe(starts.length);
  } finally { first.kill("SIGKILL"); }
});

test("concurrent stale-lock recovery admits exactly one process", async () => {
  const repo = tempRepo();
  const dir = runDir(repo, "race");
  mkdirSync(join(dir, "run.lock"), { recursive: true });
  writeFileSync(join(dir, "run.pid"), "2147483647\n");
  const ids = ["a", "b", "c", "d"];
  const children = ids.map((id) => Bun.spawn(["bun", join(import.meta.dir, "fixtures/lock-contender.ts"), repo, id], { stdout: "ignore", stderr: "inherit" }));
  const count = (prefix: string) => ids.filter((id) => existsSync(join(dir, `${prefix}-${id}`))).length;
  try {
    await waitFor(() => count("ready") === ids.length);
    writeFileSync(join(dir, "start"), "go");
    await waitFor(() => count("observed") + count("rejected") === ids.length);
    for (const id of ids) {
      if (existsSync(join(dir, `rejected-${id}`))) continue;
      writeFileSync(join(dir, `release-reader-${id}`), "go");
      await waitFor(() => existsSync(join(dir, `entered-${id}`)) || existsSync(join(dir, `rejected-${id}`)));
    }
    await waitFor(() => count("entered") + count("rejected") === ids.length);
    expect(count("entered")).toBe(1);
    expect(count("rejected")).toBe(3);
    writeFileSync(join(dir, "release-owner"), "go");
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0, 0, 0]);
    expect(existsSync(join(dir, "run.pid"))).toBe(false);
    expect(existsSync(join(dir, "run.lock"))).toBe(false);
  } finally {
    for (const child of children) child.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exited));
  }
}, 15000);


test("release leaves replacement owner markers intact", async () => {
  const repo = tempRepo();
  const state = newState({ slug: "replacement", repo, ip: "", base: "master", phase: "build" });
  const dir = runDir(repo, state.slug);
  await withRunLock(state, async () => {
    writeFileSync(join(dir, "run.lock/owner"), "replacement-owner");
    writeFileSync(join(dir, "run.pid"), "12345\n");
  });
  expect(readFileSync(join(dir, "run.lock/owner"), "utf8")).toBe("replacement-owner");
  expect(readFileSync(join(dir, "run.pid"), "utf8")).toBe("12345\n");
});

test("abandoned recovery guard fails closed without changing markers", async () => {
  const repo = tempRepo();
  const state = newState({ slug: "guarded", repo, ip: "", base: "master", phase: "build" });
  const dir = runDir(repo, state.slug);
  mkdirSync(join(dir, "run.guard"), { recursive: true });
  mkdirSync(join(dir, "run.lock"));
  writeFileSync(join(dir, "run.pid"), "2147483647\n");
  let entered = false;
  await expect(withRunLock(state, async () => { entered = true; })).rejects.toThrow("run.guard held");
  expect(entered).toBe(false);
  expect(readFileSync(join(dir, "run.pid"), "utf8")).toBe("2147483647\n");
});

test.each(["branch review", "pick REVIEW", "roast REVIEW"])("resume completes the final review round interrupted during %s", async (interrupted) => {
  const repo = tempRepo();
  const ip = join(repo, "plan.md");
  writeFileSync(ip, IP("approved"));
  const finding = {id: "R1", severity: "blocking", where: "greeting.txt", attack: "missing greeting"};
  const {config, planPath} = fakeSetup(repo, [
    {match: "branch review", result: {status: "PASS", action: "reviewed", findings: [finding]}, ...(interrupted === "branch review" ? {sleepAfterResultMs: 30000} : {})},
    {match: "pick REVIEW", write: {"greeting.txt": "hello"}, ...(interrupted === "pick REVIEW" ? {sleepAfterResultMs: 30000} : {})},
    {match: "roast REVIEW", ...(interrupted === "roast REVIEW" ? {sleepAfterResultMs: 30000} : {})},
    {match: "brew", result: {status: "BLOCKED", action: "test stops before PR"}},
  ]);
  const state = newState({slug: "final-review", repo, ip, base: "master", phase: "review"});
  state.reviewRounds = config.limits.reviewRounds - 1;
  saveState(state);
  const args = ["bun", cli, "resume", state.slug, "--repo", repo, "--go", "--no-wait"];
  const first = Bun.spawn(args, {cwd: repo, env: process.env, stdout: "ignore", stderr: "ignore"});
  const dir = runDir(repo, state.slug);
  try {
    const {readdirSync} = await import("node:fs");
    const needle = interrupted === "branch review" ? "-review-" : `-${interrupted.replace(" ", "-")}-`;
    await waitFor(() => readdirSync(join(dir, "steps")).some((name) => name.includes(needle) && name.endsWith("result.json")));
    first.kill("SIGKILL");
    await first.exited;
    // Resume must run review again and encounter the still-blocking finding.
    writeFileSync(planPath, JSON.stringify([
      {match: "branch review", result: {status: "PASS", action: "reviewed again", findings: [finding]}},
      {match: "pick REVIEW", result: {status: "BLOCKED", action: "needs a decision", ask: [{q: "Fix greeting?", rec: "yes", opts: ["yes"]}]}},
      {match: "brew", result: {status: "BLOCKED", action: "must not reach PR"}},
    ]));
    const resumed = Bun.spawnSync(args, {cwd: repo, env: process.env});
    expect(resumed.exitCode).toBe(3);
    const saved = loadState(state.slug, repo);
    expect(saved.phase).toBe("review");
    expect(saved.reviewPending).toBe(false);
    expect(saved.waiting?.message).toContain("review findings");
    expect(saved.history.some((entry) => entry.stage === "brew")).toBe(false);
    expect(saved.history.filter((entry) => entry.stage === "review" && entry.action === "reviewed again")).toHaveLength(2);
  } finally { first.kill("SIGKILL"); }
}, 15000);

test.each(["legacy interrupted", "unresolved", "passed"])("exhausted review resumes from durable %s outcome", (mode) => {
  const repo = tempRepo();
  const ip = join(repo, "plan.md");
  writeFileSync(ip, IP("approved"));
  const {config} = fakeSetup(repo, [{match: "brew", result: {status: "BLOCKED", action: "test stops before PR"}}]);
  const state = newState({slug: "exhausted", repo, ip, base: "master", phase: "review"});
  state.reviewRounds = config.limits.reviewRounds;
  if (mode !== "legacy interrupted") state.reviewFindings = mode === "passed" ? [] : [{id: "R1", severity: "blocking", attack: "still broken", evidence: "fixture"}];
  saveState(state);
  const result = Bun.spawnSync(["bun", cli, "resume", state.slug, "--repo", repo, "--go", "--no-wait"], {cwd: repo, env: process.env});
  expect(result.exitCode).toBe(3);
  const saved = loadState(state.slug, repo);
  expect(saved.phase).toBe(mode === "passed" ? "brew" : "review");
  expect(saved.history.some((entry) => entry.stage === "brew")).toBe(mode === "passed");
  expect(saved.waiting?.kind).toBe("gate");
});

test("failed final review without findings cannot authorize PR submission", () => {
  const repo = tempRepo();
  const ip = join(repo, "plan.md");
  writeFileSync(ip, IP("approved"));
  const {config} = fakeSetup(repo, [
    {match: "branch review", noResult: true},
    {match: "pick REVIEW", result: {status: "FAIL", action: "review must be rerun"}},
    {match: "brew", result: {status: "BLOCKED", action: "must not reach PR"}},
  ]);
  const state = newState({slug: "failed-review", repo, ip, base: "master", phase: "review"});
  state.reviewRounds = config.limits.reviewRounds - 1;
  saveState(state);
  const result = Bun.spawnSync(["bun", cli, "resume", state.slug, "--repo", repo, "--go", "--no-wait"], {cwd: repo, env: process.env});
  expect(result.exitCode).toBe(3);
  const saved = loadState(state.slug, repo);
  expect(saved.phase).toBe("review");
  expect(saved.reviewPending).toBe(false);
  expect(saved.reviewFindings).toHaveLength(2);
  expect(saved.history.some((entry) => entry.stage === "brew")).toBe(false);
});
