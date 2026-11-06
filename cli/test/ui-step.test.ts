// T7 (E5): GET /api/runs/:id/steps/:seq on the `brewery ui` server. Step files are written
// by hand into a run's steps/ directory, the way step.ts lays them out.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newState, runDir, saveState } from "../src/state.ts";
import { startUi } from "../src/ui/server.ts";
import { tempRepo } from "./helpers.ts";

const TOKEN = "step-token-123";
const SLUG = "demo";

interface Ui {
  port: number;
  stop: () => void | Promise<void>;
}

let ui: Ui | undefined;
const repos: string[] = [];
let savedIndex: string | undefined;

const HANDOFF = { did: "Built the route", learned: ["seq is zero padded"], traps: ["log is JSONL"], files: ["cli/src/ui/routes/step.ts"] };

const makeRepo = (phi = false): string => {
  const repo = tempRepo();
  repos.push(repo);
  if (phi) writeFileSync(join(repo, ".brewery.json"), JSON.stringify({ phi: true }));
  return repo;
};

const event = (e: Record<string, unknown>): string => `${JSON.stringify({ t: "2026-11-05T10:00:00.000Z", ...e })}\n`;

const assistant = (text: string): string =>
  `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n`;

interface StepFiles {
  seq: number;
  stage: string;
  task?: string;
  agent?: string;
  prompt?: string;
  result?: Record<string, unknown>;
  log?: string;
}

// A run whose events and steps/ files describe the given steps; saved state carries seq/history.
const writeRun = (repo: string, steps: StepFiles[], extraEvents: Record<string, unknown>[] = []): void => {
  const state = newState({ slug: SLUG, repo, ip: "docs/plans/demo.md", base: "master", phase: "build" });
  const dir = runDir(repo, SLUG);
  mkdirSync(join(dir, "steps"), { recursive: true });
  let events = "";
  for (const s of steps) {
    const agent = s.agent ?? "claude";
    const base = join(dir, "steps", `${String(s.seq).padStart(3, "0")}-${s.stage}${s.task ? `-${s.task}` : ""}-${agent}`);
    events += event({ kind: "step.start", seq: s.seq, stage: s.stage, ...(s.task ? { task: s.task } : {}), agent });
    if (s.prompt !== undefined) writeFileSync(`${base}.prompt.md`, s.prompt);
    if (s.result) writeFileSync(`${base}.result.json`, JSON.stringify(s.result));
    if (s.log !== undefined) writeFileSync(`${base}.log`, s.log);
    if (s.result) events += event({ kind: "step.end", seq: s.seq, status: s.result.status, action: s.result.action, seconds: 3 });
    state.seq = Math.max(state.seq, s.seq);
    state.history.push({ seq: s.seq, stage: s.stage, agent, status: (s.result?.status as string) ?? "PENDING", action: "", seconds: 3, log: `${base}.log`, task: s.task } as never);
  }
  for (const e of extraEvents) events += event(e);
  writeFileSync(join(dir, "events.jsonl"), events);
  saveState(state);
};

const start = async (repo: string): Promise<Ui> => {
  ui = (await startUi({ repo, port: 0, host: "127.0.0.1", token: TOKEN })) as Ui;
  return ui;
};

const runIdOf = async (): Promise<string> => {
  const res = await fetch(`http://127.0.0.1:${ui?.port}/api/runs`, { headers: { "X-Brewery-Token": TOKEN } });
  const body = (await res.json()) as { runs: { id: string }[] };
  const found = body.runs.find((r) => r.id.endsWith(`~${SLUG}`));
  if (!found) throw new Error(`run ${SLUG} not listed: ${JSON.stringify(body)}`);
  return found.id;
};

const getStep = async (seq: string, headers: Record<string, string> = { "X-Brewery-Token": TOKEN }): Promise<Response> => {
  const id = await runIdOf();
  return fetch(`http://127.0.0.1:${ui?.port}/api/runs/${encodeURIComponent(id)}/steps/${seq}`, { headers });
};

beforeEach(() => {
  savedIndex = process.env.BREWERY_INDEX;
  process.env.BREWERY_INDEX = join(tempRepo(), "index.json");
});

afterEach(async () => {
  await ui?.stop();
  ui = undefined;
  for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
  if (savedIndex === undefined) delete process.env.BREWERY_INDEX;
  else process.env.BREWERY_INDEX = savedIndex;
});

describe("GET /api/runs/:id/steps/:seq", () => {
  test("step 3 with a prompt, result, and log returns every field, with narration lines in the tail", async () => {
    const repo = makeRepo();
    writeRun(repo, [
      {
        seq: 3,
        stage: "pick",
        task: "T7",
        prompt: "# Pick T7\nDo the thing.",
        result: { status: "PASS", action: "next", summary: "done", handoff: HANDOFF },
        log: `${assistant("Reading the IP")}${JSON.stringify({ type: "result", result: "raw" })}\n${assistant("Writing the route")}`,
      },
    ]);
    await start(repo);
    const res = await getStep("3");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      seq: 3,
      stage: "pick",
      task: "T7",
      agent: "claude",
      prompt: "# Pick T7\nDo the thing.",
      handoffIn: [],
      handoffOut: HANDOFF,
      logTail: ["Reading the IP", "Writing the route"],
      phiWithheld: false,
    });
    expect(body.result).toMatchObject({ status: "PASS", action: "next" });
  });

  test("the log tail keeps only the last 80 narration lines", async () => {
    const repo = makeRepo();
    const log = Array.from({ length: 100 }, (_, i) => assistant(`line ${i}`)).join("");
    writeRun(repo, [{ seq: 1, stage: "pick", result: { status: "PASS", action: "x" }, log }]);
    await start(repo);
    const body = (await (await getStep("1")).json()) as { logTail: string[] };
    expect(body.logTail).toHaveLength(80);
    expect(body.logTail[0]).toBe("line 20");
    expect(body.logTail[79]).toBe("line 99");
  });

  test("a token in the log appears as [token] in logTail", async () => {
    const repo = makeRepo();
    const secret = `ghp_${"a1B2".repeat(9)}`;
    expect(secret).toHaveLength(40);
    writeRun(repo, [{ seq: 2, stage: "pick", log: assistant(`Using ${secret} to push`) }]);
    await start(repo);
    const res = await getStep("2");
    const text = await res.text();
    expect(text).not.toContain(secret);
    const body = JSON.parse(text) as { logTail: string[] };
    expect(body.logTail.join("\n")).toContain("[token]");
  });

  test("a token in the prompt, result, or handoffs is scrubbed in every field", async () => {
    const repo = makeRepo();
    const secret = `ghp_${"z9Y8".repeat(9)}`;
    const handoff = { did: `pushed with ${secret}`, learned: [secret], traps: [], files: [] };
    writeRun(
      repo,
      [
        { seq: 3, stage: "pick", task: "T7", prompt: `use ${secret}`, result: { status: "FAIL", action: "x", summary: secret, fail: [{ need: "a", want: "b", got: secret, ev: "d" }], handoff } },
        { seq: 5, stage: "roast", task: "T7" },
      ],
      [{ kind: "handoff", from: 3, to: 5 }],
    );
    await start(repo);
    const text3 = await (await getStep("3")).text();
    const text5 = await (await getStep("5")).text();
    expect(text3).not.toContain(secret);
    expect(text5).not.toContain(secret);
    const body3 = JSON.parse(text3) as { prompt: string; result: { summary: string; fail: { got: string }[] }; handoffOut: { did: string } };
    expect(body3.prompt).toBe("use [token]");
    expect(body3.result.summary).toBe("[token]");
    expect(body3.result.fail[0]?.got).toBe("[token]");
    expect(body3.handoffOut.did).toBe("pushed with [token]");
    const body5 = JSON.parse(text5) as { handoffIn: { handoff: { learned: string[] } }[] };
    expect(body5.handoffIn[0]?.handoff.learned).toEqual(["[token]"]);
  });

  test("a live step known only from its step.start event is found", async () => {
    const repo = makeRepo();
    writeRun(repo, [{ seq: 1, stage: "pick", result: { status: "PASS", action: "x" } }], [{ kind: "step.start", seq: 2, stage: "roast", task: "T7", agent: "codex" }]);
    await start(repo);
    const res = await getStep("2");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ seq: 2, stage: "roast", task: "T7", agent: "codex", handoffIn: [], phiWithheld: false });
  });

  test("a running step with no result file returns 200 and no result", async () => {
    const repo = makeRepo();
    writeRun(repo, [{ seq: 4, stage: "pick", prompt: "go", log: assistant("working") }]);
    await start(repo);
    const res = await getStep("4");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.seq).toBe(4);
    expect("result" in body).toBe(false);
    expect(body.handoffIn).toEqual([]);
    expect(body.logTail).toEqual(["working"]);
  });

  test("a handoff event from 3 to 5 gives step 5 handoffIn with step 3's handoff", async () => {
    const repo = makeRepo();
    writeRun(
      repo,
      [
        { seq: 3, stage: "pick", task: "T7", result: { status: "PASS", action: "x", handoff: HANDOFF } },
        { seq: 5, stage: "roast", task: "T7", prompt: "roast it" },
      ],
      [{ kind: "handoff", from: 3, to: 5 }],
    );
    await start(repo);
    const body = (await (await getStep("5")).json()) as { handoffIn: unknown[]; handoffOut?: unknown };
    expect(body.handoffIn).toEqual([{ seq: 3, handoff: HANDOFF }]);
    expect(body.handoffOut).toBeUndefined();
  });

  test("a handoff event addressed to another step does not appear in handoffIn", async () => {
    const repo = makeRepo();
    writeRun(
      repo,
      [
        { seq: 3, stage: "pick", result: { status: "PASS", action: "x", handoff: HANDOFF } },
        { seq: 5, stage: "roast" },
        { seq: 6, stage: "taste" },
      ],
      [{ kind: "handoff", from: 3, to: 6 }],
    );
    await start(repo);
    const body = (await (await getStep("5")).json()) as { handoffIn: unknown[] };
    expect(body.handoffIn).toEqual([]);
  });

  test("a phi run returns structure only: no prompt, logTail, handoffs, and a reduced result", async () => {
    const repo = makeRepo(true);
    writeRun(
      repo,
      [
        {
          seq: 3,
          stage: "pick",
          task: "T7",
          prompt: "secret prompt text",
          result: {
            status: "FAIL",
            action: "fix the patient thing",
            summary: "free text",
            fail: [
              { need: "a", want: "b", got: "c", ev: "d" },
              { need: "e", want: "f", got: "g", ev: "h" },
            ],
            ask: [{ q: "why", rec: "because", opts: ["x"] }],
            handoff: HANDOFF,
          },
          log: assistant("narration about a patient"),
        },
        { seq: 5, stage: "roast", task: "T7" },
      ],
      [{ kind: "handoff", from: 3, to: 5 }],
    );
    await start(repo);
    const res3 = await getStep("3");
    const text3 = await res3.text();
    const body3 = JSON.parse(text3) as Record<string, unknown>;
    expect(body3.phiWithheld).toBe(true);
    for (const key of ["prompt", "logTail", "handoffIn", "handoffOut"]) expect(key in body3).toBe(false);
    expect(body3.result).toEqual({ status: "FAIL", counts: { fail: 2, block: 0, ask: 1, findings: 0 } });
    for (const leak of ["secret prompt", "patient", "free text", "Built the route"]) expect(text3).not.toContain(leak);
    const body5 = (await (await getStep("5")).json()) as Record<string, unknown>;
    expect(body5.phiWithheld).toBe(true);
    expect("handoffIn" in body5).toBe(false);
  });

  test("a seq not in the run is 404", async () => {
    const repo = makeRepo();
    writeRun(repo, [{ seq: 1, stage: "pick" }]);
    await start(repo);
    const res = await getStep("99");
    expect(res.status).toBe(404);
  });

  test("a non-numeric seq is 400", async () => {
    const repo = makeRepo();
    writeRun(repo, [{ seq: 1, stage: "pick" }]);
    await start(repo);
    expect((await getStep("abc")).status).toBe(400);
  });
});
