import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
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
let indexPath = "";
let savedIndex: string | undefined;
let savedToken: string | undefined;

const makeRepo = (): string => {
  const repo = tempRepo();
  repos.push(repo);
  return repo;
};

const writeRun = (repo: string, slug: string, phase: Phase, extra: Partial<RunState> = {}, mtime?: Date): string => {
  const dir = join(repo, ".terreno", "brewery", slug);
  mkdirSync(dir, { recursive: true });
  const state: RunState = { ...newState({ slug, repo, ip: `docs/plans/${slug}.md`, base: "master", phase }), ...extra };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  if (mtime) utimesSync(join(dir, "state.json"), mtime, mtime);
  return dir;
};

const line = (event: Record<string, unknown>): string => `${JSON.stringify({ t: "2026-11-05T10:00:00.000Z", ...event })}\n`;

const start = async (repo: string, opts: Record<string, unknown> = {}): Promise<Ui> => {
  ui = (await startUi({ repo, port: 0, host: "127.0.0.1", token: TOKEN, ...opts })) as Ui;
  return ui;
};

const api = (path: string, headers: Record<string, string> = { "X-Brewery-Token": TOKEN }): Promise<Response> =>
  fetch(`http://127.0.0.1:${ui?.port}${path}`, { headers });

// fetch cannot reliably override Host, so raw http for the Host check.
const rawGet = (path: string, headers: Record<string, string>): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: ui?.port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });

interface Sse {
  messages: { id: string; data: string }[];
  next: (count: number, ms?: number) => Promise<{ id: string; data: string }[]>;
  quiet: (ms: number) => Promise<boolean>;
  close: () => void;
}

const openSse = async (id: string, headers: Record<string, string> = {}): Promise<Sse> => {
  const ctl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${ui?.port}/api/runs/${encodeURIComponent(id)}/events`, {
    headers: { "X-Brewery-Token": TOKEN, ...headers },
    signal: ctl.signal,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  const messages: { id: string; data: string }[] = [];
  let buf = "";
  let waiter: (() => void) | undefined;
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let idx = buf.indexOf("\n\n");
        while (idx >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const idLine = block.split("\n").find((l) => l.startsWith("id:"));
          const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
          if (dataLine) messages.push({ id: idLine?.slice(3).trim() ?? "", data: dataLine.slice(5).trim() });
          idx = buf.indexOf("\n\n");
        }
        waiter?.();
      }
    } catch {
      // aborted
    }
  })();
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  return {
    messages,
    next: async (count, ms = 5000) => {
      const deadline = Date.now() + ms;
      while (messages.length < count && Date.now() < deadline) {
        await Promise.race([new Promise<void>((r) => { waiter = r; }), sleep(50)]);
      }
      return messages.slice(0, count);
    },
    quiet: async (ms) => {
      const before = messages.length;
      await sleep(ms);
      return messages.length === before;
    },
    close: () => ctl.abort(),
  };
};

beforeEach(() => {
  savedIndex = process.env.BREWERY_INDEX;
  indexPath = join(makeRepo(), "index.json");
  process.env.BREWERY_INDEX = indexPath;
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

describe("brewery ui: run list", () => {
  test("lists indexed and cwd runs, newest first, with waiting flag", async () => {
    const r1 = makeRepo();
    const cwd = makeRepo();
    writeRun(r1, "a", "build", {}, new Date("2026-11-05T09:00:00Z"));
    writeRun(
      cwd,
      "b",
      "signoff",
      { waiting: { kind: "signoff", asks: [], message: "approve?", since: "2026-11-05T10:00:00Z" } },
      new Date("2026-11-05T11:00:00Z"),
    );
    writeFileSync(indexPath, JSON.stringify({ a: r1 }));
    await start(cwd);
    const res = await api("/api/runs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Record<string, unknown>[]; sources: Record<string, unknown>[] };
    expect(body.runs.map((r) => r.id)).toEqual(["local~b", "local~a"]);
    const b = body.runs[0] as Record<string, unknown>;
    const a = body.runs[1] as Record<string, unknown>;
    expect(b.waiting).toBe(true);
    expect(b.phase).toBe("signoff");
    expect(b.slug).toBe("b");
    expect(b.source).toBe("local");
    expect(b.repo).toBe(cwd);
    expect(typeof b.live).toBe("boolean");
    expect(typeof b.updatedAt).toBe("string");
    expect(a.waiting).toBe(false);
    expect(a.phase).toBe("build");
    expect(a.repo).toBe(r1);
    expect(Array.isArray(body.sources)).toBe(true);
    expect(body.sources.some((s) => s.status === "ok")).toBe(true);
  });

  test("skips an index entry whose repo no longer exists", async () => {
    const cwd = makeRepo();
    writeRun(cwd, "b", "build");
    writeFileSync(indexPath, JSON.stringify({ gone: join(cwd, "does-not-exist") }));
    await start(cwd);
    const res = await api("/api/runs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: { id: string }[] };
    expect(body.runs.map((r) => r.id)).toEqual(["local~b"]);
  });
});

describe("brewery ui: auth and routing", () => {
  test("rejects a missing token with 401", async () => {
    await start(makeRepo());
    expect((await api("/api/runs", {})).status).toBe(401);
  });

  test("rejects a wrong token with 401", async () => {
    await start(makeRepo());
    expect((await api("/api/runs", { "X-Brewery-Token": "nope" })).status).toBe(401);
  });

  test("accepts the token as a ?token= query", async () => {
    await start(makeRepo());
    expect((await api(`/api/runs?token=${TOKEN}`, {})).status).toBe(200);
  });

  test("rejects a foreign Host header with 403", async () => {
    await start(makeRepo());
    expect(await rawGet("/api/runs", { Host: "evil.example", "X-Brewery-Token": TOKEN })).toBe(403);
  });

  test("accepts a localhost Host header", async () => {
    await start(makeRepo());
    expect(await rawGet("/api/runs", { Host: `localhost:${ui?.port}`, "X-Brewery-Token": TOKEN })).toBe(200);
  });

  test("unknown run id is 404", async () => {
    await start(makeRepo());
    expect((await api("/api/runs/local~nope/events")).status).toBe(404);
  });

  test("the step route is 501 until a later task", async () => {
    const cwd = makeRepo();
    writeRun(cwd, "a", "build");
    await start(cwd);
    expect((await api("/api/runs/local~a/steps/1")).status).toBe(501);
  });

  test("returned url carries the token and the bound port", async () => {
    await start(makeRepo());
    expect(ui?.port).toBeGreaterThan(0);
    expect(ui?.url).toContain(`token=${TOKEN}`);
    expect(ui?.url).toContain(String(ui?.port));
  });

  test("GET / serves the page", async () => {
    await start(makeRepo());
    const res = await fetch(`http://127.0.0.1:${ui?.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});

describe("brewery ui: event stream", () => {
  test("delivers lines in order with increasing ids, then new lines; partial lines wait", async () => {
    const cwd = makeRepo();
    const dir = writeRun(cwd, "a", "build");
    const events = join(dir, "events.jsonl");
    writeFileSync(
      events,
      line({ kind: "step.start", seq: 1, stage: "pick", agent: "alpha" }) +
        line({ kind: "narration", seq: 1, text: "Read: a.ts" }) +
        line({ kind: "step.end", seq: 1, status: "PASS", action: "next", seconds: 3 }),
    );
    await start(cwd);
    const sse = await openSse("local~a");
    const first = await sse.next(3);
    expect(first).toHaveLength(3);
    expect(first.map((m) => (JSON.parse(m.data) as { kind: string }).kind)).toEqual(["step.start", "narration", "step.end"]);
    const ids = first.map((m) => Number(m.id));
    expect(ids[0]).toBeGreaterThan(0);
    expect(ids[1]).toBeGreaterThan(ids[0] as number);
    expect(ids[2]).toBeGreaterThan(ids[1] as number);
    // Id is the byte offset after the line.
    expect(ids[2]).toBe(Bun.file(events).size);

    const fourth = line({ kind: "done" });
    const partial = fourth.slice(0, fourth.length - 10);
    appendFileSync(events, partial);
    expect(await sse.quiet(700)).toBe(true);
    expect(sse.messages).toHaveLength(3);
    appendFileSync(events, fourth.slice(partial.length));
    const all = await sse.next(4);
    expect(all).toHaveLength(4);
    expect((JSON.parse((all[3] as { data: string }).data) as { kind: string }).kind).toBe("done");
    expect(Number((all[3] as { id: string }).id)).toBeGreaterThan(ids[2] as number);
    sse.close();
  });

  test("Last-Event-ID resumes after the given line", async () => {
    const cwd = makeRepo();
    const dir = writeRun(cwd, "a", "build");
    const events = join(dir, "events.jsonl");
    writeFileSync(events, line({ kind: "note", text: "one" }) + line({ kind: "note", text: "two" }) + line({ kind: "note", text: "three" }));
    await start(cwd);
    const s1 = await openSse("local~a");
    const got = await s1.next(3);
    s1.close();
    const afterTwo = (got[1] as { id: string }).id;
    appendFileSync(events, line({ kind: "note", text: "four" }));
    const s2 = await openSse("local~a", { "Last-Event-ID": afterTwo });
    const resumed = await s2.next(2);
    expect(resumed.map((m) => (JSON.parse(m.data) as { text: string }).text)).toEqual(["three", "four"]);
    expect(await s2.quiet(400)).toBe(true);
    expect(s2.messages).toHaveLength(2);
    s2.close();
  });

  test("opens before events.jsonl exists and delivers the first line when it appears", async () => {
    const cwd = makeRepo();
    const dir = writeRun(cwd, "a", "build");
    await start(cwd);
    const sse = await openSse("local~a");
    expect(await sse.quiet(300)).toBe(true);
    writeFileSync(join(dir, "events.jsonl"), line({ kind: "resumed" }));
    const got = await sse.next(1);
    expect(got).toHaveLength(1);
    expect((JSON.parse((got[0] as { data: string }).data) as { kind: string }).kind).toBe("resumed");
    sse.close();
  });
});

describe("brewery ui: scrubbing", () => {
  test("scrubs secrets from narration before they leave the server", async () => {
    const cwd = makeRepo();
    const dir = writeRun(cwd, "a", "build");
    writeFileSync(
      join(dir, "events.jsonl"),
      line({ kind: "narration", seq: 1, text: 'Bash: curl -H "Authorization: Bearer abc.def"' }),
    );
    await start(cwd);
    const sse = await openSse("local~a");
    const [msg] = await sse.next(1);
    sse.close();
    const ev = JSON.parse((msg as { data: string }).data) as { text: string };
    expect(ev.text).toBe('Bash: curl -H "Authorization: Bearer [token]"');
    expect((msg as { data: string }).data).not.toContain("abc.def");
  });

  test("PHI run withholds free text and keeps structure", async () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, ".brewery.json"), JSON.stringify({ phi: true }));
    const dir = writeRun(cwd, "a", "build");
    writeFileSync(
      join(dir, "events.jsonl"),
      line({ kind: "step.start", seq: 4, stage: "pick", task: "T1", agent: "alpha" }) +
        line({ kind: "narration", seq: 4, text: "Patient Jane Roe has asthma" }) +
        line({ kind: "step.end", seq: 4, status: "PASS", action: "Fix chart for Jane Roe", seconds: 12 }) +
        line({ kind: "waiting", waitingKind: "gate", message: "Jane Roe needs review" }) +
        line({ kind: "note", text: "call Jane Roe" }) +
        line({ kind: "error", message: "failed for Jane Roe" }),
    );
    await start(cwd);
    const sse = await openSse("local~a");
    const msgs = await sse.next(6);
    sse.close();
    expect(msgs).toHaveLength(6);
    const evs = msgs.map((m) => JSON.parse(m.data) as Record<string, unknown>);
    const W = "(withheld: phi)";
    expect(evs[0]).toMatchObject({ kind: "step.start", seq: 4, stage: "pick", task: "T1", agent: "alpha" });
    expect(evs[1]?.text).toBe(W);
    expect(evs[2]).toMatchObject({ kind: "step.end", status: "PASS", seconds: 12, action: W });
    expect(evs[3]?.message).toBe(W);
    expect(evs[3]).toMatchObject({ kind: "waiting", waitingKind: "gate" });
    expect(evs[4]?.text).toBe(W);
    expect(evs[5]?.message).toBe(W);
    for (const m of msgs) expect(m.data).not.toContain("Jane");
  });

  test("a repo with phi false streams narration unchanged", async () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, ".brewery.json"), JSON.stringify({ phi: false }));
    const dir = writeRun(cwd, "a", "build");
    writeFileSync(join(dir, "events.jsonl"), line({ kind: "narration", seq: 1, text: "Read: a.ts" }));
    await start(cwd);
    const sse = await openSse("local~a");
    const [msg] = await sse.next(1);
    sse.close();
    expect((JSON.parse((msg as { data: string }).data) as { text: string }).text).toBe("Read: a.ts");
  });
});

describe("brewery ui: gaps inside T1's criteria", () => {
  test("sorts by updatedAt even when the index run is the newer one", async () => {
    const r1 = makeRepo();
    const cwd = makeRepo();
    writeRun(r1, "a", "build", { pr: 42 }, new Date("2026-11-05T12:00:00Z"));
    writeRun(cwd, "b", "signoff", {}, new Date("2026-11-05T08:00:00Z"));
    writeFileSync(indexPath, JSON.stringify({ a: r1 }));
    await start(cwd);
    const body = (await (await api("/api/runs")).json()) as { runs: { id: string; pr?: number; live: boolean }[] };
    expect(body.runs.map((r) => r.id)).toEqual(["local~a", "local~b"]);
    expect(body.runs[0]?.pr).toBe(42);
    expect(body.runs[1]?.live).toBe(false);
  });

  test("live is true for a fresh waiting heartbeat", async () => {
    const cwd = makeRepo();
    writeRun(cwd, "a", "signoff", {
      waiting: { kind: "signoff", asks: [], message: "m", since: "2026-11-05T10:00:00Z", heartbeat: new Date().toISOString() } as RunState["waiting"],
    });
    await start(cwd);
    const body = (await (await api("/api/runs")).json()) as { runs: { live: boolean }[] };
    expect(body.runs[0]?.live).toBe(true);
  });

  test("PHI comes from the run's own repo, not the repo the server started in", async () => {
    const r1 = makeRepo();
    const cwd = makeRepo();
    writeFileSync(join(r1, ".brewery.json"), JSON.stringify({ phi: true }));
    const dir = writeRun(r1, "a", "build");
    writeFileSync(indexPath, JSON.stringify({ a: r1 }));
    writeFileSync(
      join(dir, "events.jsonl"),
      line({ kind: "narration", seq: 1, text: "Jane Roe" }) +
        line({ kind: "pr", number: 7, url: "https://example.test/Jane" }) +
        line({ kind: "ci", state: "fail" }),
    );
    await start(cwd);
    const sse = await openSse("local~a");
    const msgs = await sse.next(3);
    sse.close();
    const evs = msgs.map((m) => JSON.parse(m.data) as Record<string, unknown>);
    expect(evs[0]?.text).toBe("(withheld: phi)");
    expect(evs[1]).toMatchObject({ kind: "pr", number: 7, url: "(withheld: phi)" });
    expect(evs[2]).toMatchObject({ kind: "ci", state: "fail" });
  });

  test("the event stream needs the token too, and accepts it as ?token=", async () => {
    const cwd = makeRepo();
    writeRun(cwd, "a", "build");
    await start(cwd);
    expect((await api("/api/runs/local~a/events", {})).status).toBe(401);
    const ctl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${ui?.port}/api/runs/local~a/events?token=${TOKEN}`, { signal: ctl.signal });
    expect(res.status).toBe(200);
    ctl.abort();
  });

  test("the answer route is 501 until T9", async () => {
    const cwd = makeRepo();
    writeRun(cwd, "a", "build");
    await start(cwd);
    const res = await fetch(`http://127.0.0.1:${ui?.port}/api/runs/local~a/answer`, {
      method: "POST",
      headers: { "X-Brewery-Token": TOKEN, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(501);
  });

  test("`brewery ui` prints a tokened URL from BREWERY_UI_TOKEN and stops on SIGTERM", async () => {
    const cwd = makeRepo();
    writeRun(cwd, "a", "build");
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "ui", "--port", "0", "--repo", cwd], {
      env: { ...process.env, BREWERY_UI_TOKEN: "env-token-9", BREWERY_INDEX: indexPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    let out = "";
    while (!out.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    const url = out.trim();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=env-token-9$/);
    const port = Number(/:(\d+)\//.exec(url)?.[1]);
    const res = await fetch(`http://127.0.0.1:${port}/api/runs`, { headers: { "X-Brewery-Token": "env-token-9" } });
    expect(((await res.json()) as { runs: { id: string }[] }).runs.map((r) => r.id)).toEqual(["local~a"]);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    } finally {
      proc.kill("SIGKILL");
    }
  });

  test("an unreadable events.jsonl keeps the stream open and the server serving", async () => {
    const cwd = makeRepo();
    const dir = writeRun(cwd, "a", "build");
    mkdirSync(join(dir, "events.jsonl"));
    writeFileSync(join(dir, "events.jsonl", "x"), "not a file");
    await start(cwd);
    const sse = await openSse("local~a");
    expect(await sse.quiet(400)).toBe(true);
    sse.close();
    expect((await api("/api/runs")).status).toBe(200);
  });

  test("PHI withholds nested strings even under a structural key name", async () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, ".brewery.json"), JSON.stringify({ phi: true }));
    const dir = writeRun(cwd, "a", "build");
    writeFileSync(join(dir, "events.jsonl"), line({ kind: "step.end", seq: 2, status: "PASS", result: { status: "Jane Roe", count: 3 } }));
    await start(cwd);
    const sse = await openSse("local~a");
    const [msg] = await sse.next(1);
    sse.close();
    expect(JSON.parse((msg as { data: string }).data)).toMatchObject({ status: "PASS", result: { status: "(withheld: phi)", count: 3 } });
  });
});
