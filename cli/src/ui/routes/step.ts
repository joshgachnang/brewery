// One step's detail for the page's drawer: prompt, result, the handoffs it received and
// wrote, and the tail of its log as narration lines. Every string is scrubbed. A PHI run
// gets structure only: no prompt, log tail, or handoffs, and the result reduced to its
// status and counts.
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanHandoff, parseNarrationLine, type Handoff, type StepResult } from "../../agents.ts";
import { DEFAULT_CONFIG, loadConfig, type AgentProfile } from "../../config.ts";
import { scrub } from "../../scrub.ts";
import type { RunRef } from "../runs.ts";

// The drawer shows this many narration lines from the end of the log.
export const LOG_TAIL_LINES = 80;
// Only the end of a log is read; a long run's log can be many megabytes. Very large tool
// output can fill this window, leaving fewer than LOG_TAIL_LINES narration lines.
const LOG_READ_BYTES = 1024 * 1024;

const STATUSES: ReadonlySet<string> = new Set(["PASS", "FAIL", "BLOCKED", "PENDING"]);
const PARSER_TYPES: AgentProfile["type"][] = ["claude", "codex", "cursor"];

interface StepRef {
  seq: number;
  stage: string;
  task?: string;
  agent: string;
}

export interface StepDetail extends StepRef {
  prompt?: string;
  result?: StepResult | { status: string; counts: { fail: number; block: number; ask: number; findings: number } };
  handoffIn?: { seq: number; handoff: Handoff }[];
  handoffOut?: Handoff;
  logTail?: string[];
  phiWithheld: boolean;
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

// Parsed `events.jsonl`; a half-written or foreign line is skipped.
const readEvents = (run: RunRef): Record<string, unknown>[] => {
  let text: string;
  try {
    text = readFileSync(join(run.runDir, "events.jsonl"), "utf8");
  } catch {
    return [];
  }
  const events: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (isObject(event)) events.push(event);
    } catch {
      // Skip it.
    }
  }
  return events;
};

// The step's stage, task, and agent, from its first `step.start`, or from history when the
// events file lacks it. Names are only used when they are safe in a file name.
const findStep = (run: RunRef, events: Record<string, unknown>[], seq: number): StepRef | undefined => {
  const start = events.find((e) => e.kind === "step.start" && e.seq === seq);
  const entry = run.state.history.find((h) => h.seq === seq);
  const stage = str(start?.stage) ?? str(entry?.stage);
  const agent = str(start?.agent) ?? str(entry?.agent);
  const task = start ? str(start.task) : str(entry?.task);
  if (!stage || !agent) return undefined;
  const safe = /^[\w.-]+$/;
  if (!safe.test(stage) || !safe.test(agent) || (task !== undefined && !safe.test(task))) return undefined;
  return { seq, stage, ...(task ? { task } : {}), agent };
};

// step.ts's layout, rebuilt under the run directory this server resolved (history's log
// path may name another machine's or container's filesystem).
const stepBase = (run: RunRef, step: StepRef): string =>
  join(run.runDir, "steps", `${String(step.seq).padStart(3, "0")}-${step.stage}${step.task ? `-${step.task}` : ""}-${step.agent}`);

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const readResult = (base: string): Record<string, unknown> | undefined => {
  const text = readText(`${base}.result.json`);
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

// Every string in a value, scrubbed; numbers, booleans, and structure pass.
const scrubDeep = (value: unknown): unknown => {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v)]));
  return value;
};

const handoffOf = (result: Record<string, unknown> | undefined): Handoff | undefined => {
  const handoff = cleanHandoff(result?.handoff);
  return handoff ? (scrubDeep(handoff) as Handoff) : undefined;
};

// The last bytes of the log; the first, possibly partial, line is dropped when cut.
const readLogEnd = (path: string): string | undefined => {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, LOG_READ_BYTES);
    const buffer = Buffer.alloc(length);
    fd = openSync(path, "r");
    const read = readSync(fd, buffer, 0, length, size - length);
    const text = buffer.subarray(0, read).toString("utf8");
    return length < size ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

// The agent's parser when the repo's config names its type; otherwise the first parser
// that reads the line, so a run from another machine's config still narrates.
const parserTypes = (run: RunRef, agent: string): AgentProfile["type"][] => {
  let agents: Record<string, AgentProfile>;
  try {
    agents = loadConfig(run.repoRoot).agents;
  } catch {
    agents = DEFAULT_CONFIG.agents;
  }
  const type = agents[agent]?.type;
  return type ? [type] : PARSER_TYPES;
};

const logTailOf = (run: RunRef, step: StepRef, base: string): string[] | undefined => {
  const text = readLogEnd(`${base}.log`);
  if (text === undefined) return undefined;
  const types = parserTypes(run, step.agent);
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    for (const type of types) {
      const parsed = parseNarrationLine(type, line);
      if (!parsed.length) continue;
      lines.push(...parsed.map(scrub));
      break;
    }
  }
  return lines.slice(-LOG_TAIL_LINES);
};

const count = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

// A PHI run's result: its status and how many of each list it carried, nothing else.
const reducedResult = (result: Record<string, unknown>): StepDetail["result"] => ({
  status: STATUSES.has(result.status as string) ? (result.status as string) : "FAIL",
  counts: { fail: count(result.fail), block: count(result.block), ask: count(result.ask), findings: count(result.findings) },
});

const handoffsIn = (run: RunRef, events: Record<string, unknown>[], seq: number): { seq: number; handoff: Handoff }[] => {
  const received: { seq: number; handoff: Handoff }[] = [];
  for (const event of events) {
    if (event.kind !== "handoff" || event.to !== seq || typeof event.from !== "number") continue;
    if (received.some((r) => r.seq === event.from)) continue;
    const source = findStep(run, events, event.from);
    const handoff = source ? handoffOf(readResult(stepBase(run, source))) : undefined;
    if (handoff) received.push({ seq: event.from, handoff });
  }
  return received;
};

export const stepRoute = (_req: Request, run: RunRef, params: Record<string, string>): Response => {
  const raw = params.seq ?? "";
  if (!/^\d{1,9}$/.test(raw)) return json({ error: "seq must be a number" }, 400);
  const seq = Number(raw);
  const events = readEvents(run);
  const step = findStep(run, events, seq);
  if (!step) return json({ error: "no such step" }, 404);
  const base = stepBase(run, step);
  const result = readResult(base);

  if (run.phi) {
    const detail: StepDetail = { ...step, ...(result ? { result: reducedResult(result) } : {}), phiWithheld: true };
    return json(detail);
  }

  const prompt = readText(`${base}.prompt.md`);
  const handoffOut = handoffOf(result);
  const logTail = logTailOf(run, step, base);
  const detail: StepDetail = {
    ...step,
    ...(prompt !== undefined ? { prompt: scrub(prompt) } : {}),
    ...(result ? { result: scrubDeep(result) as StepResult } : {}),
    handoffIn: handoffsIn(run, events, seq),
    ...(handoffOut ? { handoffOut } : {}),
    ...(logTail ? { logTail } : {}),
    phiWithheld: false,
  };
  return json(detail);
};
