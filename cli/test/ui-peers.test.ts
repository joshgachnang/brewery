import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newState, type RunState } from "../src/state.ts";
import { startUi } from "../src/ui/server.ts";
import { tempRepo } from "./helpers.ts";

const TOKEN_A = "token-for-laptop-ui";
const TOKEN_B = "token-for-zerg-ui-SECRET";

interface Ui {
  url: string;
  port: number;
  stop: () => void | Promise<void>;
}
interface Source {
  id: string;
  kind: string;
  status: string;
  detail?: string;
}
interface RunItem {
  id: string;
  source: string;
  slug: string;
}

const uis: Ui[] = [];
const dirs: string[] = [];
const servers: { stop: (force?: boolean) => void }[] = [];
let savedIndex: string | undefined;
let savedToken: string | undefined;

const tmp = (): string => {
  const d = tempRepo();
  dirs.push(d);
  return d;
};

const writeRun = (repo: string, slug: string, extra: Partial<RunState> = {}): string => {
  const dir = join(repo, ".terreno", "brewery", slug);
  mkdirSync(dir, { recursive: true });
  const state: RunState = { ...newState({ slug, repo, ip: `docs/plans/${slug}.md`, base: "master", phase: "build" }), ...extra };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  return dir;
};

const line = (event: Record<string, unknown>): string => `${JSON.stringify({ t: "2026-11-05T10:00:00.000Z", ...event })}\n`;

const startOne = async (repo: string, token: string, peers?: { id: string; url: string; token: string }[]): Promise<Ui> => {
  const u = (await startUi({ repo, port: 0, host: "127.0.0.1", token, ...(peers ? { peers } : {}) })) as Ui;
  uis.push(u);
  return u;
};

const call = (u: Ui, token: string, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`http://127.0.0.1:${u.port}${path}`, { ...init, headers: { "X-Brewery-Token": token, ...(init.headers as Record<string, string> | undefined) } });

const list = async (u: Ui): Promise<{ runs: RunItem[]; sources: Source[] }> => {
  const res = await call(u, TOKEN_A, "/api/runs");
  expect(res.status).toBe(200);
  return (await res.json()) as { runs: RunItem[]; sources: Source[] };
};

const peerOf = (b: Ui, token = TOKEN_B): { id: string; url: string; token: string } => ({ id: "zerg", url: `http://127.0.0.1:${b.port}`, token });

const openSse = async (u: Ui, id: string, headers: Record<string, string> = {}) => {
  const ctl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${u.port}/api/runs/${encodeURIComponent(id)}/events`, {
    headers: { "X-Brewery-Token": TOKEN_A, ...headers },
    signal: ctl.signal,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  const messages: { id: string; data: string }[] = [];
  let raw = "";
  (async () => {
    try {
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        const text = dec.decode(value, { stream: true });
        raw += text;
        buf += text;
        let idx = buf.indexOf("\n\n");
        while (idx >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const idLine = block.split("\n").find((l) => l.startsWith("id:"));
          const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
          if (dataLine) messages.push({ id: idLine?.slice(3).trim() ?? "", data: dataLine.slice(5).trim() });
          idx = buf.indexOf("\n\n");
        }
      }
    } catch {
      // aborted
    }
  })();
  return {
    messages,
    raw: () => raw,
    next: async (count: number, ms = 6000) => {
      const deadline = Date.now() + ms;
      while (messages.length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      return messages.slice(0, count);
    },
    close: () => ctl.abort(),
  };
};

const texts = (msgs: { data: string }[]): string[] => msgs.map((m) => (JSON.parse(m.data) as { text: string }).text);

beforeEach(() => {
  savedIndex = process.env.BREWERY_INDEX;
  process.env.BREWERY_INDEX = join(tmp(), "index.json");
  savedToken = process.env.BREWERY_UI_TOKEN;
  delete process.env.BREWERY_UI_TOKEN;
});

afterEach(async () => {
  for (const u of uis.splice(0)) {
    try {
      await u.stop();
    } catch {
      // already stopped
    }
  }
  for (const s of servers.splice(0)) s.stop(true);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedIndex === undefined) delete process.env.BREWERY_INDEX;
  else process.env.BREWERY_INDEX = savedIndex;
  if (savedToken === undefined) delete process.env.BREWERY_UI_TOKEN;
  else process.env.BREWERY_UI_TOKEN = savedToken;
});

describe("peers: run list", () => {
  test("a peer's run is listed as <name>~<peer run id> next to local runs, with an ok peer source", async () => {
    const repoB = tmp();
    writeRun(repoB, "x");
    const repoA = tmp();
    writeRun(repoA, "mine");
    const b = await startOne(repoB, TOKEN_B);
    const a = await startOne(repoA, TOKEN_A, [peerOf(b)]);
    const body = await list(a);
    const ids = body.runs.map((r) => r.id);
    expect(ids).toContain("zerg~local~x");
    expect(ids).toContain("local~mine");
    expect(body.sources.find((s) => s.id === "zerg")).toMatchObject({ id: "zerg", kind: "peer", status: "ok" });
    expect(body.sources.find((s) => s.id === "local")?.status).toBe("ok");
  });

  test("a peer with a wrong token is unreachable with detail 401, and local runs still list", async () => {
    const repoB = tmp();
    writeRun(repoB, "x");
    const repoA = tmp();
    writeRun(repoA, "mine");
    const b = await startOne(repoB, TOKEN_B);
    const a = await startOne(repoA, TOKEN_A, [peerOf(b, "not-the-right-token")]);
    const body = await list(a);
    expect(body.sources.find((s) => s.id === "zerg")).toMatchObject({ kind: "peer", status: "unreachable", detail: "401" });
    expect(body.runs.map((r) => r.id)).toContain("local~mine");
    expect(body.runs.map((r) => r.id)).not.toContain("zerg~local~x");
  });

  test("a stopped peer shows unreachable while local runs still list", async () => {
    const repoB = tmp();
    writeRun(repoB, "x");
    const repoA = tmp();
    writeRun(repoA, "mine");
    const b = await startOne(repoB, TOKEN_B);
    const a = await startOne(repoA, TOKEN_A, [peerOf(b)]);
    expect((await list(a)).runs.map((r) => r.id)).toContain("zerg~local~x");
    await b.stop();
    const body = await list(a);
    expect(body.sources.find((s) => s.id === "zerg")).toMatchObject({ id: "zerg", kind: "peer", status: "unreachable" });
    expect(body.runs.map((r) => r.id)).toContain("local~mine");
    expect(body.runs.map((r) => r.id)).not.toContain("zerg~local~x");
  });

  test("a peer that never answers is unreachable after about 3 s", async () => {
    const hung = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });
    servers.push(hung);
    const repoA = tmp();
    writeRun(repoA, "mine");
    const a = await startOne(repoA, TOKEN_A, [{ id: "zerg", url: `http://127.0.0.1:${hung.port}`, token: TOKEN_B }]);
    const t0 = Date.now();
    const body = await list(a);
    const took = Date.now() - t0;
    expect(body.sources.find((s) => s.id === "zerg")).toMatchObject({ status: "unreachable", detail: "timeout" });
    expect(body.runs.map((r) => r.id)).toContain("local~mine");
    expect(took).toBeGreaterThanOrEqual(2500);
    expect(took).toBeLessThan(6000);
  }, 10_000);
});

describe("peers: proxied routes", () => {
  test("GET /api/runs/zerg~local~x returns B's view unchanged", async () => {
    const repoB = tmp();
    writeRun(repoB, "x");
    const b = await startOne(repoB, TOKEN_B);
    const a = await startOne(tmp(), TOKEN_A, [peerOf(b)]);
    const direct = await call(b, TOKEN_B, "/api/runs/local~x");
    expect(direct.status).toBe(200);
    const via = await call(a, TOKEN_A, "/api/runs/zerg~local~x");
    expect(via.status).toBe(200);
    expect(await via.json()).toEqual(await direct.json());
  });

  test("B's 404 for an unknown run comes back through A with the same status and body", async () => {
    const b = await startOne(tmp(), TOKEN_B);
    const a = await startOne(tmp(), TOKEN_A, [peerOf(b)]);
    const direct = await call(b, TOKEN_B, "/api/runs/local~missing");
    expect(direct.status).toBe(404);
    const via = await call(a, TOKEN_A, "/api/runs/zerg~local~missing");
    expect(via.status).toBe(404);
    expect(await via.text()).toBe(await direct.text());
  });

  test("SSE through A delivers lines appended on B in order, and forwards Last-Event-ID", async () => {
    const repoB = tmp();
    const dir = writeRun(repoB, "x");
    const events = join(dir, "events.jsonl");
    writeFileSync(events, line({ kind: "note", text: "one" }) + line({ kind: "note", text: "two" }));
    const b = await startOne(repoB, TOKEN_B);
    const a = await startOne(tmp(), TOKEN_A, [peerOf(b)]);
    const s1 = await openSse(a, "zerg~local~x");
    const first = await s1.next(2);
    expect(texts(first)).toEqual(["one", "two"]);
    appendFileSync(events, line({ kind: "note", text: "three" }) + line({ kind: "note", text: "four" }));
    const all = await s1.next(4);
    expect(texts(all)).toEqual(["one", "two", "three", "four"]);
    s1.close();

    const afterTwo = (first[1] as { id: string }).id;
    const s2 = await openSse(a, "zerg~local~x", { "Last-Event-ID": afterTwo });
    const resumed = await s2.next(2);
    expect(texts(resumed)).toEqual(["three", "four"]);
    await new Promise((r) => setTimeout(r, 400));
    expect(s2.messages).toHaveLength(2);
    s2.close();
  });

  test("POST answer through A is handled by B's answer route (reply file written on B)", async () => {
    const repoB = tmp();
    const dir = writeRun(repoB, "w", {
      phase: "signoff",
      waiting: { kind: "signoff", asks: [], message: "approve?", since: new Date().toISOString(), heartbeat: new Date().toISOString() },
    });
    const b = await startOne(repoB, TOKEN_B);
    const a = await startOne(tmp(), TOKEN_A, [peerOf(b)]);
    const res = await call(a, TOKEN_A, "/api/runs/zerg~local~w/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: "ok" }),
    });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { via: string }).via).toBe("reply-file");
    const file = join(dir, "reply.json");
    expect(existsSync(file)).toBe(true);
    expect((JSON.parse(readFileSync(file, "utf8")) as { reply: string }).reply).toBe("ok");
  });

  test("B's answer rejection (415 for a non-JSON body) comes back through A unchanged", async () => {
    const repoB = tmp();
    writeRun(repoB, "w");
    const b = await startOne(repoB, TOKEN_B);
    const a = await startOne(tmp(), TOKEN_A, [peerOf(b)]);
    const res = await call(a, TOKEN_A, "/api/runs/zerg~local~w/answer", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "reply=ok",
    });
    expect(res.status).toBe(415);
  });
});

describe("peers: token stays on the server", () => {
  test("no response from A (page, list, view, SSE, errors) contains B's token", async () => {
    const repoB = tmp();
    const dir = writeRun(repoB, "x");
    writeFileSync(join(dir, "events.jsonl"), line({ kind: "note", text: "hello" }));
    const b = await startOne(repoB, TOKEN_B);
    const a = await startOne(tmp(), TOKEN_A, [peerOf(b)]);

    const bodies: string[] = [];
    const grab = async (res: Response): Promise<void> => {
      bodies.push(JSON.stringify([...res.headers.entries()]));
      bodies.push(await res.text());
    };
    await grab(await fetch(`http://127.0.0.1:${a.port}/?token=${TOKEN_A}`));
    await grab(await call(a, TOKEN_A, "/api/runs"));
    await grab(await call(a, TOKEN_A, "/api/runs/zerg~local~x"));
    await grab(await call(a, TOKEN_A, "/api/runs/zerg~local~missing"));
    const sse = await openSse(a, "zerg~local~x");
    await sse.next(1);
    bodies.push(sse.raw());
    sse.close();

    expect(bodies.join("\n")).not.toContain(TOKEN_B);
  });

  test("an unreachable peer's source detail does not leak its token", async () => {
    const b = await startOne(tmp(), TOKEN_B);
    const a = await startOne(tmp(), TOKEN_A, [peerOf(b, "wrong-token-should-not-leak")]);
    const res = await call(a, TOKEN_A, "/api/runs");
    const text = await res.text();
    expect(text).toContain("unreachable");
    expect(text).not.toContain("wrong-token-should-not-leak");
    expect(text).not.toContain(TOKEN_B);
  });
});
