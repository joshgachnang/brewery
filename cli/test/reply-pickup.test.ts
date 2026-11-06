// T8: a waiting brewery process picks up a reply written to `.terreno/brewery/<slug>/reply.json`.
// Unit cases drive `waitForReply` directly; process cases (E6) drive `brewery pour` against the fake agent.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { waitForReply } from "../src/human.ts";
import { loadState, newState, runDir, saveState, type RunState } from "../src/state.ts";
import { fakeSetup, run, tempRepo } from "./helpers.ts";
import { IP } from "./helpers.ts";

setDefaultTimeout(60_000);

const CLI = join(import.meta.dir, "../src/cli.ts");

const waitingState = (slug = "greet"): RunState => {
  const repo = tempRepo();
  fakeSetup(repo, []);
  const state = newState({ slug, repo, ip: join(repo, "docs/plans/greet.md"), base: "master", phase: "signoff" });
  state.waiting = { kind: "signoff", asks: [], message: "Approve?", since: new Date().toISOString() };
  saveState(state);
  return state;
};

const replyPath = (state: RunState): string => join(runDir(state.repo, state.slug), "reply.json");
const writeReply = (state: RunState, body: string): void => {
  mkdirSync(runDir(state.repo, state.slug), { recursive: true });
  writeFileSync(replyPath(state), body);
};
const events = (state: RunState): Array<Record<string, unknown>> => {
  const path = join(runDir(state.repo, state.slug), "events.jsonl");
  return existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
};
const heartbeatOf = (state: RunState): unknown => (loadState(state.slug, state.repo).waiting as { heartbeat?: unknown } | undefined)?.heartbeat;

describe("waitForReply", () => {
  test("takes a reply written to reply.json while waiting, and deletes the file", async () => {
    const state = waitingState();
    setTimeout(() => writeReply(state, JSON.stringify({ reply: "ok" })), 100);

    expect(await waitForReply({ state, tty: null, replyWaitMin: 1, pollMs: 20 })).toBe("ok");
    expect(existsSync(replyPath(state))).toBe(false);
  });

  test("takes a reply file that was already there when the wait began", async () => {
    const state = waitingState();
    writeReply(state, JSON.stringify({ reply: "no, use markdown", at: "2026-11-05T10:00:00.000Z" }));

    expect(await waitForReply({ state, tty: null, replyWaitMin: 1, pollMs: 20 })).toBe("no, use markdown");
    expect(existsSync(replyPath(state))).toBe(false);
  });

  test("still accepts a terminal line when a TTY is attached and no file has appeared", async () => {
    const state = waitingState();
    const tty = new PassThrough();
    setTimeout(() => tty.write("1a\n"), 50);

    expect(await waitForReply({ state, tty, replyWaitMin: 1, pollMs: 20 })).toBe("1a");
    expect(existsSync(replyPath(state))).toBe(false);
  });

  test("keeps watching the file while a TTY is attached but silent", async () => {
    const state = waitingState();
    const tty = new PassThrough();
    setTimeout(() => writeReply(state, JSON.stringify({ reply: "ok" })), 150);

    expect(await waitForReply({ state, tty, replyWaitMin: 1, pollMs: 20 })).toBe("ok");
    expect(existsSync(replyPath(state))).toBe(false);
  });

  test("rewrites state.waiting.heartbeat repeatedly while waiting", async () => {
    const state = waitingState();
    const pending = waitForReply({ state, tty: null, replyWaitMin: 1, pollMs: 40 });
    const seen = new Set<string>();
    const deadline = Date.now() + 12_000;
    while (seen.size < 2 && Date.now() < deadline) {
      const beat = heartbeatOf(state);
      if (beat !== undefined) seen.add(String(beat));
      await Bun.sleep(25);
    }
    writeReply(state, JSON.stringify({ reply: "ok" }));
    await pending;

    expect(seen.size).toBeGreaterThanOrEqual(2);
  });

  test("returns null at once with replyWaitMin 0 and no TTY", async () => {
    const state = waitingState();
    const started = Date.now();

    expect(await waitForReply({ state, tty: null, replyWaitMin: 0, pollMs: 20 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("gives up with null once replyWaitMin has elapsed and no reply came", async () => {
    const state = waitingState();
    const started = Date.now();

    expect(await waitForReply({ state, tty: null, replyWaitMin: 0.01, pollMs: 20 })).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("ignores a malformed reply.json, leaves it, emits a note, and keeps waiting", async () => {
    const state = waitingState();
    writeReply(state, "{not json");
    const pending = waitForReply({ state, tty: null, replyWaitMin: 1, pollMs: 20 });
    await Bun.sleep(300);

    expect(readFileSync(replyPath(state), "utf8")).toBe("{not json");
    expect(events(state).some((e) => e.kind === "note" && String(e.text).includes("reply.json unreadable"))).toBe(true);

    writeReply(state, JSON.stringify({ reply: "ok" }));
    expect(await pending).toBe("ok");
    expect(existsSync(replyPath(state))).toBe(false);
  });
});

// ---- process cases: a whole `brewery pour` against the fake agent, no TTY ----

const draft = (asks: unknown[]) => [
  { match: "distill (write the IP)", write: { "docs/plans/greet.md": IP("draft") }, result: { status: "PASS", action: "drafted", ip: "docs/plans/greet.md", ask: asks } },
  { match: "cut", result: { status: "PASS", action: "attacked", findings: [] } },
];
const fundamental = { q: "Who sees the greeting?", rec: "Everyone", opts: ["Everyone", "Staff only"], fundamental: true };
const build = [
  { match: "test T", result: { status: "PASS", action: "nothing to test", tests: [], untestable: "a fixture task" } },
  { match: "pick T1", write: { "greeting.txt": "hello\n" }, result: { status: "PASS", action: "built" } },
  { match: "pick T2", write: { "farewell.txt": "bye\n" }, result: { status: "PASS", action: "built" } },
  { match: "roast T", result: { status: "PASS", action: "proven" } },
];

const spawnPour = (repo: string, env: Record<string, string | undefined>) => {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return Bun.spawn(["bun", CLI, "pour", "Add a greeting file.", "--slug", "greet", "--ip", "docs/plans/greet.md", "--repo", repo], {
    cwd: repo,
    env: merged as Record<string, string>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
};

const eventsAt = (repo: string): Array<Record<string, unknown>> =>
  events({ repo, slug: "greet" } as RunState);

const waitUntil = async (check: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(50);
  }
  return check();
};

const exitCodeWithin = async (proc: ReturnType<typeof spawnPour>, ms: number): Promise<number | "timeout"> => {
  const result = await Promise.race([proc.exited, Bun.sleep(ms).then(() => "timeout" as const)]);
  if (result === "timeout") proc.kill();
  return result;
};

describe("reply pickup in a whole run", () => {
  test("a pour run waiting at sign-off approves from reply.json and continues into barrel in the same process", async () => {
    const repo = tempRepo();
    fakeSetup(repo, [...draft([fundamental]), ...build]);
    writeFileSync(join(repo, ".brewery.json"), JSON.stringify({ limits: { testFirst: true } }));
    run(repo, "git", "add", "-A");
    run(repo, "git", "commit", "-q", "-m", "Config");
    const proc = spawnPour(repo, { BREWERY_REPLY_WAIT_MIN: "1" });

    const waiting = await waitUntil(() => eventsAt(repo).some((e) => e.kind === "waiting"), 30_000);
    expect(waiting).toBe(true);
    writeFileSync(join(runDir(repo, "greet"), "reply.json"), JSON.stringify({ reply: "ok", at: new Date().toISOString() }));

    const continued = await waitUntil(() => eventsAt(repo).some((e) => e.kind === "step.start" && e.stage === "pick"), 30_000);
    proc.kill();

    expect(continued).toBe(true);
    expect(eventsAt(repo).some((e) => e.kind === "resumed")).toBe(true);
    expect(existsSync(join(runDir(repo, "greet"), "reply.json"))).toBe(false);
  });

  test("with the default wait of 0 the run still exits 3 at once at sign-off", async () => {
    const repo = tempRepo();
    fakeSetup(repo, draft([fundamental]));
    const proc = spawnPour(repo, { BREWERY_REPLY_WAIT_MIN: undefined });

    expect(await exitCodeWithin(proc, 30_000)).toBe(3);
    expect(loadState("greet", repo).waiting?.kind).toBe("signoff");
  });

  test("BREWERY_REPLY_WAIT_MIN sets the wait, and a replyWaitMin in the repo's .brewery.json is ignored", async () => {
    const repo = tempRepo();
    fakeSetup(repo, draft([fundamental]));
    writeFileSync(join(repo, ".brewery.json"), JSON.stringify({ replyWaitMin: 240 }));
    run(repo, "git", "add", "-A");
    run(repo, "git", "commit", "-q", "-m", "Config");
    const proc = spawnPour(repo, { BREWERY_REPLY_WAIT_MIN: "0.03" });

    // 0.03 min is 1.8 s: the run waits, then exits 3. A 240-minute repo value would hang past the limit.
    expect(await exitCodeWithin(proc, 45_000)).toBe(3);
    const waitingEvent = eventsAt(repo).find((e) => e.kind === "waiting");
    expect(waitingEvent).toBeDefined();
    const waitedMs = Date.now() - Date.parse(String(waitingEvent?.t));
    expect(waitedMs).toBeGreaterThanOrEqual(1500);
  });

  test("replyWaitMin in the user config sets the wait when the env var is unset", async () => {
    const repo = tempRepo();
    fakeSetup(repo, draft([fundamental]));
    const configPath = process.env.BREWERY_CONFIG as string;
    const user = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...user, replyWaitMin: 0.03 }));
    const proc = spawnPour(repo, { BREWERY_REPLY_WAIT_MIN: undefined });

    expect(await exitCodeWithin(proc, 45_000)).toBe(3);
    const waitingEvent = eventsAt(repo).find((e) => e.kind === "waiting");
    expect(waitingEvent).toBeDefined();
    expect(Date.now() - Date.parse(String(waitingEvent?.t))).toBeGreaterThanOrEqual(1500);
  });
});
