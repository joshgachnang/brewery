import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newState, type Phase, type RunState } from "../src/state.ts";
import { startUi } from "../src/ui/server.ts";
import { tempRepo } from "./helpers.ts";

const TOKEN = "test-token-123";

interface Ui {
  url: string;
  port: number;
  stop: () => void | Promise<void>;
}

let ui: Ui | undefined;
const repos: string[] = [];
let savedIndex: string | undefined;
let savedToken: string | undefined;

const makeRepo = (): string => {
  const repo = tempRepo();
  repos.push(repo);
  return repo;
};

const stateFile = (repo: string, slug: string): string => join(repo, ".terreno", "brewery", slug, "state.json");

let tick = 0;
// Every write gets a distinct, increasing mtime so the one-second poll always sees a change.
const bump = (path: string): void => {
  tick += 5;
  const when = new Date(Date.now() + tick * 1000);
  utimesSync(path, when, when);
};

const writeRun = (repo: string, slug: string, phase: Phase): string => {
  const dir = join(repo, ".terreno", "brewery", slug);
  mkdirSync(dir, { recursive: true });
  const state: RunState = newState({ slug, repo, ip: `docs/plans/${slug}.md`, base: "master", phase });
  writeFileSync(stateFile(repo, slug), JSON.stringify(state));
  bump(stateFile(repo, slug));
  return dir;
};

const rewritePhase = (repo: string, slug: string, phase: Phase): void => {
  const state: RunState = newState({ slug, repo, ip: `docs/plans/${slug}.md`, base: "master", phase });
  writeFileSync(stateFile(repo, slug), JSON.stringify(state));
  bump(stateFile(repo, slug));
};

const line = (event: Record<string, unknown>): string => `${JSON.stringify({ t: "2026-11-05T10:00:00.000Z", ...event })}\n`;

const start = async (repo: string): Promise<Ui> => {
  ui = (await startUi({ repo, port: 0, host: "127.0.0.1", token: TOKEN })) as Ui;
  return ui;
};

const api = (path: string, headers: Record<string, string> = { "X-Brewery-Token": TOKEN }): Promise<Response> =>
  fetch(`http://127.0.0.1:${ui?.port}${path}`, { headers });

interface Msg {
  event: string;
  id: string;
  data: string;
}

interface Sse {
  messages: Msg[];
  waitFor: (pred: (m: Msg) => boolean, ms: number) => Promise<Msg | undefined>;
  close: () => void;
}

const openSse = async (id: string): Promise<Sse> => {
  const ctl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${ui?.port}/api/runs/${encodeURIComponent(id)}/events`, {
    headers: { "X-Brewery-Token": TOKEN },
    signal: ctl.signal,
  });
  expect(res.status).toBe(200);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  const messages: Msg[] = [];
  let buf = "";
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let idx = buf.indexOf("\n\n");
        while (idx >= 0) {
          const lines = buf.slice(0, idx).split("\n");
          buf = buf.slice(idx + 2);
          const field = (name: string): string => lines.find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? "";
          if (lines.some((l) => l.startsWith("data:"))) messages.push({ event: field("event"), id: field("id"), data: field("data") });
          idx = buf.indexOf("\n\n");
        }
      }
    } catch {
      // aborted
    }
  })();
  return {
    messages,
    waitFor: async (pred, ms) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const hit = messages.find(pred);
        if (hit || Date.now() > deadline) return hit;
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    close: () => ctl.abort(),
  };
};

const stageStatus = (view: { pipeline: { stage: string; status: string }[] }, stage: string): string | undefined =>
  view.pipeline.find((p) => p.stage === stage)?.status;

const stateMsg = (pred: (view: { pipeline: { stage: string; status: string }[] }) => boolean) => (m: Msg): boolean => {
  if (m.event !== "state") return false;
  try {
    return pred(JSON.parse(m.data));
  } catch {
    return false;
  }
};

beforeEach(() => {
  savedIndex = process.env.BREWERY_INDEX;
  process.env.BREWERY_INDEX = join(makeRepo(), "index.json");
  savedToken = process.env.BREWERY_UI_TOKEN;
  delete process.env.BREWERY_UI_TOKEN;
});

afterEach(async () => {
  await ui?.stop();
  ui = undefined;
  for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
  if (savedIndex === undefined) delete process.env.BREWERY_INDEX;
  else process.env.BREWERY_INDEX = savedIndex;
  if (savedToken === undefined) delete process.env.BREWERY_UI_TOKEN;
  else process.env.BREWERY_UI_TOKEN = savedToken;
});

describe("brewery ui: run view route", () => {
  test("a run in build with one running step returns the view with one active card", async () => {
    const repo = makeRepo();
    const dir = writeRun(repo, "a", "build");
    writeFileSync(
      join(dir, "events.jsonl"),
      line({ kind: "step.start", seq: 1, stage: "pick", task: "T1", agent: "claude-sonnet" }),
    );
    await start(repo);
    const res = await api("/api/runs/local~a");
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view.active.length).toBe(1);
    expect(view.active[0].seq).toBe(1);
    expect(view.active[0].stage).toBe("pick");
    expect(view.active[0].status).toBe("running");
    expect(stageStatus(view, "barrel")).toBe("active");
    expect(Array.isArray(view.tasks)).toBe(true);
    expect(view.totals).toBeDefined();
  });

  test("configuredRoutes come from the run's repo .brewery.json", async () => {
    const repo = makeRepo();
    writeRun(repo, "a", "build");
    writeFileSync(join(repo, ".brewery.json"), JSON.stringify({ stages: { pick: ["codex"] } }));
    await start(repo);
    const view = await (await api("/api/runs/local~a")).json();
    expect(view.routes.pick.agents).toEqual(["codex"]);
    expect(view.routes.pick.from).toBe("config");
  });

  const phiFixture = (phi: boolean): string => {
    const repo = makeRepo();
    const dir = writeRun(repo, "a", "build");
    const state: RunState = newState({ slug: "a", repo, ip: "docs/plans/a.md", base: "master", phase: "build" });
    state.waiting = {
      kind: "gate",
      message: "Ask Jane Doe's guardian",
      asks: [{ q: "Call Jane Doe?", rec: "Jane Doe consent first", opts: ["Jane Doe now"] }],
      since: "2026-11-05T10:00:00.000Z",
    };
    writeFileSync(stateFile(repo, "a"), JSON.stringify(state));
    bump(stateFile(repo, "a"));
    if (phi) writeFileSync(join(repo, ".brewery.json"), JSON.stringify({ phi: true }));
    writeFileSync(
      join(dir, "events.jsonl"),
      line({ kind: "step.start", seq: 1, stage: "pick", task: "T1", agent: "claude-sonnet" }) +
        line({ kind: "narration", seq: 1, text: "Patient Jane Doe has asthma" }) +
        line({ kind: "step.end", seq: 1, status: "FAIL", seconds: 3, action: "Recheck Jane Doe chart" }) +
        line({ kind: "step.start", seq: 2, stage: "pick", task: "T1", agent: "claude-sonnet" }) +
        line({ kind: "narration", seq: 2, text: "Patient Jane Doe again" }),
    );
    return repo;
  };

  test("a PHI run's view withholds free text", async () => {
    await start(phiFixture(true));
    const res = await api("/api/runs/local~a");
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain("Jane Doe");
  });

  test("the same run without PHI shows its narration, action, and waiting text", async () => {
    await start(phiFixture(false));
    const view = await (await api("/api/runs/local~a")).json();
    expect(view.active[0].narration).toEqual(["Patient Jane Doe again"]);
    expect(view.steps[0].action).toBe("Recheck Jane Doe chart");
    expect(view.waiting.message).toBe("Ask Jane Doe's guardian");
  });

  test("a corrupt state.json answers 500 with an error that quotes nothing from the file", async () => {
    const repo = makeRepo();
    writeRun(repo, "a", "build");
    writeFileSync(stateFile(repo, "a"), '{ "waiting": "Patient Jane Doe');
    await start(repo);
    const res = await api("/api/runs/local~a");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(JSON.stringify(body)).not.toContain("Jane");
  });

  test("a state.json the view cannot be built from answers 500 JSON, and the stream skips it", async () => {
    const repo = makeRepo();
    writeRun(repo, "a", "build");
    await start(repo);
    const sse = await openSse("local~a");
    writeFileSync(stateFile(repo, "a"), JSON.stringify({ slug: "a", phase: "build" }));
    bump(stateFile(repo, "a"));
    const res = await api("/api/runs/local~a");
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(typeof (await res.json()).error).toBe("string");
    await new Promise((r) => setTimeout(r, 1500));
    sse.close();
    expect(sse.messages.filter((x) => x.event === "state").length).toBe(0);
  });

  test("task fields brewery would not write are coerced, never echoed into a PHI view", async () => {
    const repo = makeRepo();
    writeRun(repo, "a", "build");
    writeFileSync(join(repo, ".brewery.json"), JSON.stringify({ phi: true }));
    const state = { ...newState({ slug: "a", repo, ip: "docs/plans/a.md", base: "master", phase: "build" }), tasks: { T1: { status: "Jane", attempts: "Doe" } } };
    writeFileSync(stateFile(repo, "a"), JSON.stringify(state));
    await start(repo);
    const res = await api("/api/runs/local~a");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("Jane");
    expect(body).not.toContain("Doe");
    const task = JSON.parse(body).tasks[0];
    expect(task.status).toBe("todo");
    expect(task.attempts).toBe(0);
  });

  test("a broken run's other routes answer 404, not 500", async () => {
    const repo = makeRepo();
    writeRun(repo, "a", "build");
    writeFileSync(stateFile(repo, "a"), "{ not json");
    await start(repo);
    expect((await api("/api/runs/local~a/bogus")).status).toBe(404);
  });

  test("an unknown id answers 404, and a request without the token answers 401", async () => {
    const repo = makeRepo();
    writeRun(repo, "a", "build");
    await start(repo);
    expect((await api("/api/runs/local~nope")).status).toBe(404);
    expect((await api("/api/runs/local~a", {})).status).toBe(401);
  });
});

describe("brewery ui: state push", () => {
  test("a new phase in state.json arrives as a `state` message within 3 s", async () => {
    const repo = makeRepo();
    writeRun(repo, "a", "build");
    await start(repo);
    const sse = await openSse("local~a");
    rewritePhase(repo, "a", "brew");
    const hit = await sse.waitFor(stateMsg((v) => stageStatus(v, "finish") === "active"), 3000);
    sse.close();
    expect(hit).toBeDefined();
    // Last-Event-ID is an events.jsonl offset; a view must not move it.
    expect(hit?.id).toBe("");
    const view = JSON.parse(hit?.data ?? "{}");
    expect(stageStatus(view, "barrel")).toBe("done");
    expect(Array.isArray(view.active)).toBe(true);
  });

  test("a corrupt state.json keeps the stream open, and the next valid write recovers it", async () => {
    const repo = makeRepo();
    writeRun(repo, "a", "build");
    await start(repo);
    const sse = await openSse("local~a");
    writeFileSync(stateFile(repo, "a"), "{ not json");
    bump(stateFile(repo, "a"));
    // Give the poll time to see the corrupt file, then write a valid one.
    await new Promise((r) => setTimeout(r, 1500));
    // The corrupt write pushed nothing.
    expect(sse.messages.filter((x) => x.event === "state").length).toBe(0);
    rewritePhase(repo, "a", "brew");
    const hit = await sse.waitFor(stateMsg((v) => stageStatus(v, "finish") === "active"), 3500);
    sse.close();
    expect(hit).toBeDefined();
    // The recovered view is the first state message, and none carried the corrupt content.
    expect(sse.messages.find((x) => x.event === "state")).toBe(hit as Msg);
    for (const m of sse.messages) expect(m.data).not.toContain("not json");
  }, 10_000);
});
