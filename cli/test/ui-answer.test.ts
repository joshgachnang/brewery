// T9 (E7): POST /api/runs/:id/answer and /note on the `brewery ui` server.
// Process cases spawn a real `brewery` against the fake agent; the stubbed-source cases swap
// `findRun` with spyOn because scanned (non-writable) runs have no on-disk source yet.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadState, newState, runDir, saveState, type Phase, type RunState } from "../src/state.ts";
import * as runs from "../src/ui/runs.ts";
import { startUi } from "../src/ui/server.ts";
import { fakeSetup, IP, tempRepo } from "./helpers.ts";

setDefaultTimeout(90_000);

const TOKEN = "answer-token-123";
const CLI = join(import.meta.dir, "../src/cli.ts");

interface Ui {
  port: number;
  stop: () => Promise<void>;
}

let ui: Ui | undefined;
const repos: string[] = [];
const spies: Array<{ mockRestore: () => void }> = [];
let savedIndex: string | undefined;
let savedWait: string | undefined;

const makeRepo = (): string => {
  const repo = tempRepo();
  repos.push(repo);
  return repo;
};

const start = async (repo: string): Promise<Ui> => {
  ui = (await startUi({ repo, port: 0, host: "127.0.0.1", token: TOKEN })) as Ui;
  return ui;
};

const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  raw?: string,
): Promise<Response> =>
  fetch(`http://127.0.0.1:${ui?.port}${path}`, {
    method: "POST",
    headers: { "X-Brewery-Token": TOKEN, "Content-Type": "application/json", ...headers },
    body: raw ?? JSON.stringify(body),
  });

const waitUntil = async (check: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(50);
  }
  return check();
};

const eventsOf = (repo: string, slug: string): Array<Record<string, unknown>> => {
  const path = join(runDir(repo, slug), "events.jsonl");
  return existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
};

const uiLogs = (repo: string, slug: string): string[] =>
  readdirSync(runDir(repo, slug)).filter((f) => /^ui-answer-.*\.log$/.test(f));

// A run on disk with a hand-written state, for cases that never run a process.
const writeRun = (repo: string, slug: string, phase: Phase, extra: Partial<RunState> = {}): RunState => {
  const state: RunState = { ...newState({ slug, repo, ip: `docs/plans/${slug}.md`, base: "master", phase }), ...extra };
  saveState(state);
  return state;
};

const waiting = (heartbeat?: string): RunState["waiting"] => ({
  kind: "signoff",
  asks: [],
  message: "Approve?",
  since: new Date().toISOString(),
  ...(heartbeat ? { heartbeat } : {}),
});

const replyPath = (repo: string, slug: string): string => join(runDir(repo, slug), "reply.json");

const stubRun = (id: string, ref: runs.RunRef): void => {
  const real = runs.findRun;
  spies.push(spyOn(runs, "findRun").mockImplementation((given, ctx) => (given === id ? ref : real(given, ctx))));
};

beforeEach(() => {
  savedIndex = process.env.BREWERY_INDEX;
  savedWait = process.env.BREWERY_REPLY_WAIT_MIN;
  delete process.env.BREWERY_REPLY_WAIT_MIN;
});

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  await ui?.stop();
  ui = undefined;
  for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
  if (savedIndex === undefined) delete process.env.BREWERY_INDEX;
  else process.env.BREWERY_INDEX = savedIndex;
  if (savedWait === undefined) delete process.env.BREWERY_REPLY_WAIT_MIN;
  else process.env.BREWERY_REPLY_WAIT_MIN = savedWait;
});

// ---- a live waiter takes the reply from reply.json ----

describe("answer: live waiter", () => {
  test("a waiter with a 2 s old heartbeat gets reply.json and the route returns 202 reply-file", async () => {
    const repo = makeRepo();
    fakeSetup(repo, []);
    writeRun(repo, "greet", "signoff", { waiting: waiting(new Date(Date.now() - 2000).toISOString()) });
    await start(repo);

    const res = await post("/api/runs/local~greet/answer", { reply: "ok" });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ via: "reply-file" });
    expect(JSON.parse(readFileSync(replyPath(repo, "greet"), "utf8")).reply).toBe("ok");
    expect(uiLogs(repo, "greet")).toEqual([]);
  });

  test("a stale heartbeat (30 s) is not a live waiter: no reply.json, a detached answer is spawned instead", async () => {
    const repo = makeRepo();
    fakeSetup(repo, []);
    writeRun(repo, "greet", "signoff", { waiting: waiting(new Date(Date.now() - 30_000).toISOString()) });
    await start(repo);

    const res = await post("/api/runs/local~greet/answer", { reply: "ok" });

    expect(((await res.json()) as { via?: string }).via).toBe("spawn");
    expect(existsSync(replyPath(repo, "greet"))).toBe(false);
    // Let the child finish before the temp repo is removed.
    await waitUntil(() => uiLogs(repo, "greet").length > 0 && !existsSync(join(runDir(repo, "greet"), "run.pid")), 15_000);
  });
});

// ---- no waiter: spawn a detached `brewery answer` ----

const draftPlan = [
  {
    match: "distill (write the IP)",
    write: { "docs/plans/greet.md": IP("draft") },
    result: {
      status: "PASS",
      action: "drafted",
      ip: "docs/plans/greet.md",
      ask: [{ q: "Who sees the greeting?", rec: "Everyone", opts: ["Everyone", "Staff only"], fundamental: true }],
    },
  },
  { match: "cut", result: { status: "PASS", action: "attacked", findings: [] } },
];

const runCli = (repo: string, ...argv: string[]): number =>
  Bun.spawnSync(["bun", CLI, ...argv], { cwd: repo, env: process.env }).exitCode ?? -1;

describe("answer: spawn a detached brewery answer", () => {
  test("a local run waiting at sign-off with no waiter, reply ok → 202 spawn and the child approves it", async () => {
    const repo = makeRepo();
    fakeSetup(repo, draftPlan);
    expect(runCli(repo, "pour", "Add a greeting file.", "--slug", "greet", "--ip", "docs/plans/greet.md", "--repo", repo)).toBe(3);
    expect(loadState("greet", repo).waiting?.kind).toBe("signoff");
    await start(repo);

    const res = await post("/api/runs/local~greet/answer", { reply: "ok" });
    const body = (await res.json()) as { via: string; pid: number; log: string };

    expect(res.status).toBe(202);
    expect(body.via).toBe("spawn");
    expect(Number.isInteger(body.pid)).toBe(true);
    expect(basename(body.log)).toMatch(/^ui-answer-.*\.log$/);
    expect(await waitUntil(() => loadState("greet", repo).phase === "approved", 30_000)).toBe(true);
    expect(existsSync(body.log)).toBe(true);
    expect(uiLogs(repo, "greet")).toHaveLength(1);
    expect(existsSync(replyPath(repo, "greet"))).toBe(false);
  });

  test("a local run at a gate with no waiter, reply 'retry: use the fixture' → 202 spawn and the child continues the build", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "docs/plans"), { recursive: true });
    const ip = join(repo, "docs/plans/greet.md");
    writeFileSync(ip, IP("approved 2026-09-28"));
    fakeSetup(repo, [
      { match: "pick T1", write: { "greeting.txt": "hello\n" }, result: { status: "PASS", action: "built" } },
      { match: "roast T1", result: { status: "PASS", action: "proven" } },
      { match: "pick T2", result: { status: "BLOCKED", action: "needs decision", ask: [{ q: "Proceed?", rec: "retry", opts: ["retry", "stop"] }] } },
    ]);
    saveState(newState({ slug: "greet", repo, ip, base: "master", phase: "approved" }));
    expect(runCli(repo, "barrel", "greet", "--repo", repo, "--no-wait")).toBe(3);
    expect(loadState("greet", repo).waiting?.kind).toBe("gate");
    const picksBefore = eventsOf(repo, "greet").filter((e) => e.kind === "step.start" && e.stage === "pick").length;
    await start(repo);

    const res = await post("/api/runs/local~greet/answer", { reply: "retry: use the fixture" });
    const body = (await res.json()) as { via: string; log: string };

    expect(res.status).toBe(202);
    expect(body.via).toBe("spawn");
    const picked = await waitUntil(
      () => eventsOf(repo, "greet").filter((e) => e.kind === "step.start" && e.stage === "pick").length > picksBefore,
      45_000,
    );
    expect(picked).toBe(true);
    // The child ends by waiting again (the same pick is still BLOCKED) or by finishing.
    const settled = await waitUntil(() => {
      const state = loadState("greet", repo);
      return !existsSync(join(runDir(repo, "greet"), "run.pid")) && (state.waiting !== undefined || state.phase === "done");
    }, 45_000);
    expect(settled).toBe(true);
    expect(existsSync(body.log)).toBe(true);
  });
});

// ---- 409s ----

describe("answer: cannot or must not act", () => {
  test("a scanned run (stubbed, not writable) waiting with no waiter → 409 with the command to run in that session", async () => {
    const repo = makeRepo();
    const dir = join(repo, "scanned");
    mkdirSync(dir, { recursive: true });
    const state = newState({ slug: "x", repo, ip: "", base: "master", phase: "signoff" });
    state.waiting = waiting();
    stubRun("scan~ws1~x", { state, source: "scan~ws1", runDir: dir, repoRoot: repo, phi: false, writable: false });
    await start(repo);

    const res = await post("/api/runs/scan~ws1~x/answer", { reply: "ok" });
    const body = (await res.json()) as { error: string; command: string };

    expect(res.status).toBe(409);
    expect(body.command).toBe('brewery answer x "ok"');
    expect(typeof body.error).toBe("string");
    expect(existsSync(join(dir, "reply.json"))).toBe(false);
  });

  test("a scanned run's command quotes a reply a shell would expand, so it pastes as is", async () => {
    const repo = makeRepo();
    const dir = join(repo, "scanned");
    mkdirSync(dir, { recursive: true });
    const state = newState({ slug: "x", repo, ip: "", base: "master", phase: "signoff" });
    state.waiting = waiting();
    stubRun("scan~ws1~x", { state, source: "scan~ws1", runDir: dir, repoRoot: repo, phi: false, writable: false });
    await start(repo);

    const res = await post("/api/runs/scan~ws1~x/answer", { reply: "no: it's $HOME!" });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { command: string }).command).toBe("brewery answer x 'no: it'\\''s $HOME!'");
  });

  test("a second answer while the spawned child is starting → 409, and only one child is spawned", async () => {
    const repo = makeRepo();
    fakeSetup(repo, []);
    writeRun(repo, "greet", "signoff", { waiting: waiting() });
    await start(repo);

    const first = await post("/api/runs/local~greet/answer", { reply: "ok" });
    const second = await post("/api/runs/local~greet/answer", { reply: "ok" });

    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    expect(uiLogs(repo, "greet")).toHaveLength(1);
    const { pid } = (await first.json()) as { pid: number };
    // Let the child finish before the temp repo is removed.
    await waitUntil(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 30_000);
  });

  test("findRun writable:false with a live waiter → 409 with command, and no reply.json is written", async () => {
    const repo = makeRepo();
    const dir = join(repo, "scanned");
    mkdirSync(dir, { recursive: true });
    const state = newState({ slug: "x", repo, ip: "", base: "master", phase: "signoff" });
    state.waiting = waiting(new Date(Date.now() - 2000).toISOString());
    stubRun("scan~ws1~x", { state, source: "scan~ws1", runDir: dir, repoRoot: repo, phi: false, writable: false });
    await start(repo);

    const res = await post("/api/runs/scan~ws1~x/answer", { reply: "ok" });

    expect(res.status).toBe(409);
    expect(typeof ((await res.json()) as { command?: unknown }).command).toBe("string");
    expect(existsSync(join(dir, "reply.json"))).toBe(false);
  });

  test("a live process holds run.lock and the run is not waiting → 409 and nothing is spawned", async () => {
    const repo = makeRepo();
    fakeSetup(repo, []);
    writeRun(repo, "greet", "build");
    const dir = runDir(repo, "greet");
    mkdirSync(join(dir, "run.lock"), { recursive: true });
    writeFileSync(join(dir, "run.pid"), `${process.pid}\n`);
    await start(repo);

    const res = await post("/api/runs/local~greet/answer", { reply: "ok" });

    expect(res.status).toBe(409);
    expect(uiLogs(repo, "greet")).toEqual([]);
    expect(existsSync(replyPath(repo, "greet"))).toBe(false);
  });

  test("a live process holds run.lock and the run is waiting with no live waiter → 409 and nothing is spawned", async () => {
    const repo = makeRepo();
    fakeSetup(repo, []);
    writeRun(repo, "greet", "signoff", { waiting: waiting() });
    const dir = runDir(repo, "greet");
    mkdirSync(join(dir, "run.lock"), { recursive: true });
    writeFileSync(join(dir, "run.pid"), `${process.pid}\n`);
    await start(repo);

    const res = await post("/api/runs/local~greet/answer", { reply: "ok" });

    expect(res.status).toBe(409);
    expect(uiLogs(repo, "greet")).toEqual([]);
  });

  test("a run that is not waiting: answer → 409, note → 200 and the text lands in state.notes", async () => {
    const repo = makeRepo();
    fakeSetup(repo, []);
    writeRun(repo, "greet", "build");
    await start(repo);

    const answered = await post("/api/runs/local~greet/answer", { reply: "ok" });
    const noted = await post("/api/runs/local~greet/note", { text: "prefer the short label" });

    expect(answered.status).toBe(409);
    expect(uiLogs(repo, "greet")).toEqual([]);
    expect(noted.status).toBe(200);
    expect(loadState("greet", repo).notes).toEqual(["prefer the short label"]);
    expect(eventsOf(repo, "greet").some((e) => e.kind === "note" && e.text === "prefer the short label")).toBe(true);
  });
});

// ---- request validation: each case also proves the same request succeeds when valid ----

describe("answer: request validation", () => {
  const setup = async (): Promise<string> => {
    const repo = makeRepo();
    fakeSetup(repo, []);
    writeRun(repo, "greet", "signoff", { waiting: waiting(new Date().toISOString()) });
    await start(repo);
    return repo;
  };

  test("an empty or missing reply → 400 and nothing is written; a real reply then works", async () => {
    const repo = await setup();

    for (const body of [{ reply: "" }, { reply: "   " }, {}]) {
      expect((await post("/api/runs/local~greet/answer", body)).status).toBe(400);
    }
    expect((await post("/api/runs/local~greet/answer", undefined, {}, "{not json")).status).toBe(400);
    expect(existsSync(replyPath(repo, "greet"))).toBe(false);

    expect((await post("/api/runs/local~greet/answer", { reply: "ok" })).status).toBe(202);
  });

  test("an empty note → 400 and no note is appended; a real note then works", async () => {
    const repo = await setup();

    expect((await post("/api/runs/local~greet/note", { text: "  " })).status).toBe(400);
    expect((await post("/api/runs/local~greet/note", {})).status).toBe(400);
    expect(loadState("greet", repo).notes).toEqual([]);

    expect((await post("/api/runs/local~greet/note", { text: "keep it short" })).status).toBe(200);
    expect(loadState("greet", repo).notes).toEqual(["keep it short"]);
  });

  test("a form-encoded body → 415 and nothing is written; JSON then works", async () => {
    const repo = await setup();

    const form = await post("/api/runs/local~greet/answer", undefined, { "Content-Type": "application/x-www-form-urlencoded" }, "reply=ok");
    const text = await post("/api/runs/local~greet/note", undefined, { "Content-Type": "text/plain" }, JSON.stringify({ text: "x" }));

    expect(form.status).toBe(415);
    expect(text.status).toBe(415);
    expect(existsSync(replyPath(repo, "greet"))).toBe(false);
    expect(loadState("greet", repo).notes).toEqual([]);
    expect((await post("/api/runs/local~greet/answer", { reply: "ok" })).status).toBe(202);
  });

  test("no token → 401 and nothing is written", async () => {
    const repo = await setup();

    const res = await fetch(`http://127.0.0.1:${ui?.port}/api/runs/local~greet/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: "ok" }),
    });

    expect(res.status).toBe(401);
    expect(existsSync(replyPath(repo, "greet"))).toBe(false);
    expect((await post("/api/runs/local~greet/answer", { reply: "ok" })).status).toBe(202);
  });

  test("a foreign Origin → 403 and nothing is written; the page's own Origin works", async () => {
    const repo = await setup();

    const foreign = await post("/api/runs/local~greet/answer", { reply: "ok" }, { Origin: "https://evil.example" });
    const foreignNote = await post("/api/runs/local~greet/note", { text: "x" }, { Origin: "https://evil.example" });

    expect(foreign.status).toBe(403);
    expect(foreignNote.status).toBe(403);
    expect(existsSync(replyPath(repo, "greet"))).toBe(false);
    expect(loadState("greet", repo).notes).toEqual([]);
    const own = await post("/api/runs/local~greet/answer", { reply: "ok" }, { Origin: `http://127.0.0.1:${ui?.port}` });
    expect(own.status).toBe(202);
  });
});
