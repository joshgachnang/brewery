import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newState, type Phase, type RunState } from "../src/state.ts";
import { findRun } from "../src/ui/runs.ts";
import { startUi } from "../src/ui/server.ts";
import { tempRepo } from "./helpers.ts";

const TOKEN = "test-token-123";
const isRoot = process.getuid?.() === 0;

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
  repo?: string;
  slug: string;
  workspace?: string;
  waiting: boolean;
}

let ui: Ui | undefined;
const dirs: string[] = [];
let savedIndex: string | undefined;
let savedToken: string | undefined;

const tmp = (): string => {
  const d = tempRepo();
  dirs.push(d);
  return d;
};

// <root>/<ws>/merged is a zerg workspace; the run lives under its .terreno/brewery/<slug>.
const writeScanRun = (root: string, ws: string, slug: string, extra: Partial<RunState> = {}): string => {
  const merged = join(root, ws, "merged");
  const dir = join(merged, ".terreno", "brewery", slug);
  mkdirSync(dir, { recursive: true });
  const state: RunState = {
    ...newState({ slug, repo: "/workspace", ip: `docs/plans/${slug}.md`, base: "master", phase: "build" }),
    ...extra,
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  return dir;
};

const line = (event: Record<string, unknown>): string => `${JSON.stringify({ t: "2026-11-05T10:00:00.000Z", ...event })}\n`;

const start = async (glob: string[]): Promise<Ui> => {
  ui = (await startUi({ repo: tmp(), port: 0, host: "127.0.0.1", token: TOKEN, scan: glob })) as Ui;
  return ui;
};

const api = (path: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${ui?.port}${path}`, { headers: { "X-Brewery-Token": TOKEN } });

const list = async (): Promise<{ runs: RunItem[]; sources: Source[] }> => {
  const res = await api("/api/runs");
  expect(res.status).toBe(200);
  return (await res.json()) as { runs: RunItem[]; sources: Source[] };
};

const scanIds = (body: { runs: RunItem[] }): string[] => body.runs.map((r) => r.id).filter((id) => id.startsWith("scan~")).sort();

beforeEach(() => {
  savedIndex = process.env.BREWERY_INDEX;
  process.env.BREWERY_INDEX = join(tmp(), "index.json");
  savedToken = process.env.BREWERY_UI_TOKEN;
  delete process.env.BREWERY_UI_TOKEN;
});

afterEach(async () => {
  await ui?.stop();
  ui = undefined;
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(d, 0o755);
    } catch {
      // gone
    }
    // restore modes inside so rmSync can walk them
    for (const sub of ["ws3/merged", "ws1/merged/.terreno/brewery/feat"]) {
      try {
        chmodSync(join(d, sub), 0o755);
      } catch {
        // absent
      }
    }
    rmSync(d, { recursive: true, force: true });
  }
  if (savedIndex === undefined) delete process.env.BREWERY_INDEX;
  else process.env.BREWERY_INDEX = savedIndex;
  if (savedToken === undefined) delete process.env.BREWERY_UI_TOKEN;
  else process.env.BREWERY_UI_TOKEN = savedToken;
});

describe("brewery ui --scan: run list", () => {
  test("two workspaces holding the same slug stay apart as scan~<workspace>~<slug>", async () => {
    const root = tmp();
    writeScanRun(root, "ws1", "feat");
    writeScanRun(root, "ws2", "feat");
    await start([`${root}/*/merged`]);
    const body = await list();
    expect(scanIds(body)).toEqual(["scan~ws1~feat", "scan~ws2~feat"]);
    const run = body.runs.find((r) => r.id === "scan~ws2~feat");
    expect(run?.source).toBe("scan");
    expect(run?.workspace).toBe("ws2");
    expect(run?.slug).toBe("feat");
    const src = body.sources.find((s) => s.kind === "scan");
    expect(src?.id).toBe(`scan:${root}/*/merged`);
    expect(src?.status).toBe("ok");
  });

  test("a glob that matches nothing reports an ok source and no runs", async () => {
    const root = tmp();
    await start([`${root}/nothing-*/merged`]);
    const body = await list();
    expect(scanIds(body)).toEqual([]);
    const src = body.sources.find((s) => s.kind === "scan");
    expect(src?.status).toBe("ok");
  });

  test("a workspace with .terreno/brewery but no state.json is skipped", async () => {
    const root = tmp();
    mkdirSync(join(root, "ws1", "merged", ".terreno", "brewery", "feat"), { recursive: true });
    writeScanRun(root, "ws2", "real");
    await start([`${root}/*/merged`]);
    expect(scanIds(await list())).toEqual(["scan~ws2~real"]);
  });

  test.skipIf(isRoot)("an unreadable workspace is reported as unreadable and the other runs still list", async () => {
    const root = tmp();
    writeScanRun(root, "ws1", "feat");
    mkdirSync(join(root, "ws3", "merged"), { recursive: true });
    chmodSync(join(root, "ws3", "merged"), 0o000);
    await start([`${root}/*/merged`]);
    const body = await list();
    expect(scanIds(body)).toEqual(["scan~ws1~feat"]);
    expect(body.sources.some((s) => s.kind === "scan" && s.status === "unreadable")).toBe(true);
  });

  test.skipIf(isRoot)("a run directory the server cannot write makes the source read-only", async () => {
    const root = tmp();
    const dir = writeScanRun(root, "ws1", "feat");
    chmodSync(dir, 0o555);
    await start([`${root}/*/merged`]);
    const body = await list();
    expect(scanIds(body)).toEqual(["scan~ws1~feat"]);
    expect(body.sources.find((s) => s.kind === "scan")?.status).toBe("read-only");
  });
});

describe("brewery ui --scan: routes resolve scanned runs", () => {
  test("the view and events routes resolve scan~ws2~feat to ws2's run directory", async () => {
    const root = tmp();
    const d1 = writeScanRun(root, "ws1", "feat");
    const d2 = writeScanRun(root, "ws2", "feat");
    writeFileSync(join(d1, "events.jsonl"), line({ kind: "step.start", seq: 1, stage: "pick", task: "T1", agent: "ws1-agent" }));
    writeFileSync(join(d2, "events.jsonl"), line({ kind: "step.start", seq: 7, stage: "roast", task: "T2", agent: "ws2-agent" }));
    await start([`${root}/*/merged`]);

    const res = await api("/api/runs/scan~ws2~feat");
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view.active.length).toBe(1);
    expect(view.active[0].seq).toBe(7);
    expect(view.active[0].agent).toBe("ws2-agent");

    const ctl = new AbortController();
    const ev = await fetch(`http://127.0.0.1:${ui?.port}/api/runs/scan~ws2~feat/events`, {
      headers: { "X-Brewery-Token": TOKEN },
      signal: ctl.signal,
    });
    expect(ev.status).toBe(200);
    expect(ev.headers.get("content-type")).toContain("text/event-stream");
    const reader = (ev.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 3000;
    while (!text.includes("ws2-agent") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    ctl.abort();
    expect(text).toContain("ws2-agent");
    expect(text).not.toContain("ws1-agent");
  });
});

describe("brewery ui --scan: PHI is read from the workspace's .brewery.json", () => {
  const fixture = (brewery: Record<string, unknown> | undefined): string => {
    const root = tmp();
    const dir = writeScanRun(root, "ws1", "feat", {
      history: [
        {
          seq: 1,
          stage: "pick",
          agent: "claude-sonnet",
          status: "PASS",
          action: "Recheck Jane Doe chart",
          seconds: 3,
          log: "/workspace/.terreno/brewery/feat/steps/001-pick-T1-claude.log",
          task: "T1",
        },
      ],
    });
    if (brewery) writeFileSync(join(root, "ws1", "merged", ".brewery.json"), JSON.stringify(brewery));
    writeFileSync(
      join(dir, "events.jsonl"),
      line({ kind: "step.start", seq: 2, stage: "pick", task: "T1", agent: "claude-sonnet" }) +
        line({ kind: "narration", seq: 2, text: "Patient Jane Doe has asthma" }),
    );
    return root;
  };

  test("a workspace with no .brewery.json is not PHI, so narration is shown", async () => {
    const root = fixture(undefined);
    await start([`${root}/*/merged`]);
    const view = await (await api("/api/runs/scan~ws1~feat")).json();
    expect(view.active[0].narration).toEqual(["Patient Jane Doe has asthma"]);
  });

  test('a workspace .brewery.json with "phi": true withholds narration and every free-text field', async () => {
    const root = fixture({ phi: true });
    await start([`${root}/*/merged`]);
    const res = await api("/api/runs/scan~ws1~feat");
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(JSON.stringify(view)).not.toContain("Jane Doe");
    expect(view.active[0].narration ?? []).toEqual([]);
  });

  test("the events stream of a PHI workspace withholds free text", async () => {
    const root = fixture({ phi: true });
    await start([`${root}/*/merged`]);
    const ctl = new AbortController();
    const ev = await fetch(`http://127.0.0.1:${ui?.port}/api/runs/scan~ws1~feat/events`, {
      headers: { "X-Brewery-Token": TOKEN },
      signal: ctl.signal,
    });
    expect(ev.status).toBe(200);
    const reader = (ev.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 3000;
    while (!text.includes("withheld") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    ctl.abort();
    expect(text).toContain("(withheld: phi)");
    expect(text).not.toContain("Jane Doe");
  });
});

describe("brewery ui --scan: findRun rebases container paths onto the workspace", () => {
  test("runDir, repoRoot, and step logs are host paths; a log outside the container repo is dropped", async () => {
    const root = tmp();
    const merged = join(root, "ws1", "merged");
    writeScanRun(root, "ws1", "feat", {
      history: [
        { seq: 1, stage: "pick", agent: "claude", status: "PASS", action: "", seconds: 1, log: "/workspace/.terreno/brewery/feat/steps/001-pick-T1-claude.log" },
        { seq: 2, stage: "pick", agent: "claude", status: "PASS", action: "", seconds: 1, log: "/etc/passwd" },
        { seq: 3, stage: "pick", agent: "claude", status: "PASS", action: "", seconds: 1, log: "/workspace/../../../etc/passwd" },
      ],
    });
    const ref = findRun("scan~ws1~feat", { repo: tmp(), scan: [`${root}/*/merged`] });
    expect(ref?.runDir).toBe(join(merged, ".terreno", "brewery", "feat"));
    expect(ref?.repoRoot).toBe(merged);
    expect(ref?.state.repo).toBe(merged);
    expect(ref?.state.history[0]?.log).toBe(join(merged, ".terreno", "brewery", "feat", "steps", "001-pick-T1-claude.log"));
    expect(ref?.state.history[1]?.log).toBe("");
    expect(ref?.state.history[2]?.log).toBe("");
    expect(ref?.writable).toBe(true);

    await start([`${root}/*/merged`]);
    expect((await list()).runs.find((r) => r.id === "scan~ws1~feat")?.repo).toBe(merged);
  });

  test.skipIf(isRoot)("a run directory the server cannot write resolves with writable: false", () => {
    const root = tmp();
    chmodSync(writeScanRun(root, "ws1", "feat"), 0o555);
    expect(findRun("scan~ws1~feat", { repo: tmp(), scan: [`${root}/*/merged`] })?.writable).toBe(false);
  });

  test("unknown or unsafe scan ids are 404", async () => {
    const root = tmp();
    writeScanRun(root, "ws1", "feat");
    await start([`${root}/*/merged`]);
    for (const id of ["scan~ws9~feat", "scan~..~feat", "scan~ws1~..", "scan~feat"]) {
      expect((await api(`/api/runs/${encodeURIComponent(id)}`)).status).toBe(404);
    }
  });
});

describe("brewery ui --scan: a workspace cannot reach outside itself", () => {
  test("a .terreno symlink into another (PHI) workspace is not served under this workspace", async () => {
    const root = tmp();
    const other = writeScanRun(root, "ws2", "feat");
    writeFileSync(join(root, "ws2", "merged", ".brewery.json"), JSON.stringify({ phi: true }));
    writeFileSync(join(other, "events.jsonl"), line({ kind: "narration", seq: 1, text: "Patient Jane Doe" }));
    mkdirSync(join(root, "ws1", "merged"), { recursive: true });
    symlinkSync("../../ws2/merged/.terreno", join(root, "ws1", "merged", ".terreno"));
    await start([`${root}/*/merged`]);
    expect(scanIds(await list())).toEqual(["scan~ws2~feat"]);
    expect((await api("/api/runs/scan~ws1~feat/events")).status).toBe(404);
  });

  test("a symlinked events.jsonl makes the run unresolvable", () => {
    const root = tmp();
    const dir = writeScanRun(root, "ws1", "feat");
    writeFileSync(join(root, "elsewhere.jsonl"), "");
    symlinkSync(join(root, "elsewhere.jsonl"), join(dir, "events.jsonl"));
    expect(findRun("scan~ws1~feat", { repo: tmp(), scan: [`${root}/*/merged`] })).toBeUndefined();
  });

  test.skipIf(isRoot)("a run directory the server cannot read is reported as unreadable", async () => {
    const root = tmp();
    writeScanRun(root, "ws2", "real");
    chmodSync(writeScanRun(root, "ws1", "feat"), 0o000);
    await start([`${root}/*/merged`]);
    const body = await list();
    expect(scanIds(body)).toEqual(["scan~ws2~real"]);
    const src = body.sources.find((s) => s.kind === "scan");
    expect(src?.status).toBe("unreadable");
    expect(src?.detail).toContain(join(root, "ws1", "merged", ".terreno", "brewery", "feat"));
  });
});

// A step entry in history, so the step route can find seq's file names.
const histEntry = (seq: number): RunState["history"][number] => ({
  seq,
  stage: "pick",
  task: "T1",
  agent: "claude",
  status: "PASS",
  action: "next",
  seconds: 1,
  log: `/workspace/.terreno/brewery/feat/steps/${String(seq).padStart(3, "0")}-pick-T1-claude.log`,
});
const stepName = (seq: number): string => `${String(seq).padStart(3, "0")}-pick-T1-claude`;

describe("brewery ui --scan: step artifacts cannot be links out of the workspace", () => {
  const SECRET = "secret-host-file-content";

  test("a symlinked step prompt, result, or log is not served", async () => {
    const root = tmp();
    const dir = writeScanRun(root, "ws1", "feat", { history: [histEntry(1)] });
    const outside = join(root, "hostsecret.txt");
    writeFileSync(outside, `${SECRET}\n`);
    writeFileSync(join(root, "hostresult.json"), JSON.stringify({ status: "PASS", action: "x", summary: SECRET }));
    mkdirSync(join(dir, "steps"), { recursive: true });
    symlinkSync(outside, join(dir, "steps", `${stepName(1)}.prompt.md`));
    symlinkSync(join(root, "hostresult.json"), join(dir, "steps", `${stepName(1)}.result.json`));
    symlinkSync(outside, join(dir, "steps", `${stepName(1)}.log`));
    await start([`${root}/*/merged`]);
    const res = await api("/api/runs/scan~ws1~feat/steps/1");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const body = JSON.parse(text) as { prompt?: string; result?: unknown };
    expect(body.prompt).toBeUndefined();
    expect(body.result).toBeUndefined();
  });

  test("a symlinked steps/ directory is not served, and neither are the handoffs read through it", async () => {
    const root = tmp();
    const dir = writeScanRun(root, "ws1", "feat", { history: [histEntry(1), histEntry(2)] });
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, `${stepName(2)}.prompt.md`), `${SECRET}\n`);
    const handoff = { did: SECRET, learned: [], traps: [], files: [] };
    writeFileSync(join(elsewhere, `${stepName(1)}.result.json`), JSON.stringify({ status: "PASS", action: "x", summary: "s", handoff }));
    symlinkSync(elsewhere, join(dir, "steps"));
    writeFileSync(join(dir, "events.jsonl"), line({ kind: "handoff", from: 1, to: 2 }));
    await start([`${root}/*/merged`]);
    const res = await api("/api/runs/scan~ws1~feat/steps/2");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect((JSON.parse(text) as { handoffIn: unknown[] }).handoffIn).toEqual([]);
  });

  test("a plain step prompt inside the workspace is still served", async () => {
    const root = tmp();
    const dir = writeScanRun(root, "ws1", "feat", { history: [histEntry(1)] });
    mkdirSync(join(dir, "steps"), { recursive: true });
    writeFileSync(join(dir, "steps", `${stepName(1)}.prompt.md`), "build T1\n");
    await start([`${root}/*/merged`]);
    const body = (await (await api("/api/runs/scan~ws1~feat/steps/1")).json()) as { prompt?: string };
    expect(body.prompt).toBe("build T1\n");
  });
});

describe("brewery ui --scan: answering a scanned run", () => {
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`http://127.0.0.1:${ui?.port}${path}`, {
      method: "POST",
      headers: { "X-Brewery-Token": TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  test("a writable scanned run waiting with no live waiter → 409 with the command, and nothing is spawned", async () => {
    const root = tmp();
    const waiting: RunState["waiting"] = { kind: "signoff", asks: [], message: "Approve?", since: new Date().toISOString() };
    const dir = writeScanRun(root, "ws1", "feat", { phase: "signoff" as Phase, waiting });
    expect(findRun("scan~ws1~feat", { repo: tmp(), scan: [`${root}/*/merged`] })?.writable).toBe(true);
    await start([`${root}/*/merged`]);
    const res = await post("/api/runs/scan~ws1~feat/answer", { reply: "ok" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; command: string };
    expect(body.error).toContain("no live waiter");
    expect(body.command).toBe('brewery answer feat "ok"');
    expect(readdirSync(dir).filter((f) => f.startsWith("ui-answer-"))).toEqual([]);
    expect(readdirSync(dir)).not.toContain("reply.json");
  });

  test("a writable scanned run with a live waiter still gets reply.json", async () => {
    const root = tmp();
    const waiting: RunState["waiting"] = {
      kind: "signoff",
      asks: [],
      message: "Approve?",
      since: new Date().toISOString(),
      heartbeat: new Date().toISOString(),
    };
    const dir = writeScanRun(root, "ws1", "feat", { phase: "signoff" as Phase, waiting });
    await start([`${root}/*/merged`]);
    const res = await post("/api/runs/scan~ws1~feat/answer", { reply: "ok" });
    expect(res.status).toBe(202);
    expect(readdirSync(dir)).toContain("reply.json");
  });
});
