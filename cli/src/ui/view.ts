// The run view model: everything the dashboard page draws, derived from a run's state and
// its events. The page renders this and derives nothing, so `bun test` covers all UI logic.
import type { Ask, Status } from "../agents.ts";
import { STAGES, type Stage } from "../config.ts";
import type { BreweryEvent } from "../events.ts";
import type { RunState, TaskState } from "../state.ts";
import { scrub } from "../scrub.ts";

export const PIPELINE = ["distill", "cut", "signoff", "barrel", "finish"] as const;
export type PipelineStage = (typeof PIPELINE)[number];
export type PipelineStatus = "done" | "active" | "waiting" | "todo" | "skipped";

export const NARRATION_LINES = 20;
export const WITHHELD = "(withheld: phi)";
// A waiter that refreshed its heartbeat this recently is still at its prompt.
export const LIVE_HEARTBEAT_MS = 15_000;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  costUsd?: number;
}

export interface StepCard {
  seq: number;
  stage: string;
  task?: string;
  agent: string;
  status: "running" | Status;
  startedAt: string;
  seconds?: number;
  action?: string;
  narration: string[];
  usage?: Usage;
}

export interface TaskView {
  id: string;
  title: string;
  status: TaskState["status"];
  attempts: number;
  lanes: { test: StepCard[]; pick: StepCard[]; roast: StepCard[] };
}

export interface RunView {
  pipeline: { stage: PipelineStage; status: PipelineStatus }[];
  tasks: TaskView[];
  active: StepCard[];
  steps: StepCard[];
  routes: Record<Stage, { agents: string[]; from: "run" | "config" }>;
  // In a PHI run the message is withheld and the asks are reduced to their count.
  waiting?: { kind: "signoff" | "gate"; message: string; asks: Ask[] | number; live: boolean };
  pr?: { number: number; url: string; ci?: "pass" | "fail" | "pending" };
  // `seconds` sums finished steps' agent time, not the run's wall-clock time.
  totals: { seconds: number; costUsd?: number; inputTokens?: number; outputTokens?: number };
  handoffs: { from: number; to: number }[];
}

export interface RunViewInput {
  state: RunState;
  // Parsed events.jsonl lines; each carries the `t` timestamp appendEvent writes.
  events: (BreweryEvent & { t?: string })[];
  configuredRoutes: Record<Stage, string[]>;
  phi: boolean;
  now: Date;
  // Task titles from the IP, by task id. A task without one is titled by its id.
  titles?: Record<string, string>;
}

const STATUSES: ReadonlySet<string> = new Set<Status>(["PASS", "FAIL", "BLOCKED", "PENDING"]);
const LANES = ["test", "pick", "roast"] as const;

const addUsage = (sum: Usage | undefined, add: Usage): Usage => {
  const out: Usage = { inputTokens: (sum?.inputTokens ?? 0) + add.inputTokens, outputTokens: (sum?.outputTokens ?? 0) + add.outputTokens };
  if (sum?.cacheReadTokens !== undefined || add.cacheReadTokens !== undefined) out.cacheReadTokens = (sum?.cacheReadTokens ?? 0) + (add.cacheReadTokens ?? 0);
  if (sum?.costUsd !== undefined || add.costUsd !== undefined) out.costUsd = (sum?.costUsd ?? 0) + (add.costUsd ?? 0);
  return out;
};

const buildPipeline = (state: RunState, started: ReadonlySet<string>): RunView["pipeline"] => {
  const statuses = ((): PipelineStatus[] => {
    switch (state.phase) {
      case "distill":
        return started.has("cut") ? ["done", "active", "todo", "todo", "todo"] : ["active", "todo", "todo", "todo", "todo"];
      case "signoff":
        return ["done", "done", "waiting", "todo", "todo"];
      case "approved":
      case "build":
      case "integrate":
      case "review":
        return ["done", "done", "done", state.waiting ? "waiting" : "active", "todo"];
      case "brew":
      case "finish":
        return ["done", "done", "done", "done", "active"];
      case "done":
        return ["done", "done", "done", "done", "done"];
      default:
        // A phase from another brewery version: draw the strip rather than fail the view.
        return ["todo", "todo", "todo", "todo", "todo"];
    }
  })();
  // A run started by `barrel` on an existing IP never distilled, cut, or signed off.
  const planned = started.has("distill") || started.has("cut") || state.history.some((h) => h.stage === "distill" || h.stage === "cut");
  if (!planned && state.phase !== "distill" && state.phase !== "signoff") statuses.splice(0, 3, "skipped", "skipped", "skipped");
  return PIPELINE.map((stage, i) => ({ stage, status: statuses[i] as PipelineStatus }));
};

export const buildRunView = ({ state, events, configuredRoutes, phi, now, titles }: RunViewInput): RunView => {
  const cards = new Map<number, StepCard>();
  const seen = new Map<string, string[]>();
  const handoffs: RunView["handoffs"] = [];
  let pr: RunView["pr"];
  let ci: "pass" | "fail" | "pending" | undefined;

  for (const event of events) {
    switch (event.kind) {
      case "step.start": {
        if (cards.has(event.seq)) break;
        cards.set(event.seq, {
          seq: event.seq,
          stage: event.stage,
          ...(event.task ? { task: event.task } : {}),
          agent: event.agent,
          status: "running",
          startedAt: event.t ?? "",
          narration: [],
        });
        const agents = seen.get(event.stage) ?? [];
        if (!agents.includes(event.agent)) seen.set(event.stage, [...agents, event.agent]);
        break;
      }
      case "step.end": {
        const card = cards.get(event.seq);
        if (!card) break;
        card.status = STATUSES.has(event.status) ? (event.status as Status) : "FAIL";
        card.seconds = event.seconds;
        if (!phi && event.action) card.action = scrub(event.action);
        break;
      }
      case "narration": {
        const card = cards.get(event.seq);
        if (!card || phi) break;
        card.narration.push(scrub(event.text));
        if (card.narration.length > NARRATION_LINES) card.narration.shift();
        break;
      }
      case "usage": {
        const card = cards.get(event.seq);
        if (card) card.usage = addUsage(card.usage, event);
        break;
      }
      case "handoff":
        handoffs.push({ from: event.from, to: event.to });
        break;
      case "pr":
        pr = { number: event.number, url: event.url };
        break;
      case "ci":
        ci = event.state;
        break;
    }
  }

  const steps = [...cards.values()].sort((a, b) => a.seq - b.seq);
  const started = new Set(steps.map((c) => c.stage));

  const tasks = Object.entries(state.tasks).map(([id, task]): TaskView => {
    const lane = (stage: (typeof LANES)[number]): StepCard[] => steps.filter((c) => c.task === id && c.stage === stage);
    return {
      id,
      title: phi ? id : (titles?.[id] ?? id),
      status: task.status,
      attempts: task.attempts,
      lanes: { test: lane("test"), pick: lane("pick"), roast: lane("roast") },
    };
  });

  const routes = Object.fromEntries(
    STAGES.map((stage) => {
      const ran = seen.get(stage);
      return [stage, ran ? { agents: ran, from: "run" as const } : { agents: configuredRoutes[stage] ?? [], from: "config" as const }];
    }),
  ) as RunView["routes"];

  let waiting: RunView["waiting"];
  if (state.waiting) {
    const heartbeat = (state.waiting as { heartbeat?: string }).heartbeat;
    const beat = heartbeat ? Date.parse(heartbeat) : Number.NaN;
    waiting = {
      kind: state.waiting.kind,
      message: phi ? WITHHELD : scrub(state.waiting.message),
      asks: phi
        ? state.waiting.asks.length
        : state.waiting.asks.map((a) => ({ ...a, q: scrub(a.q), rec: scrub(a.rec), ...(a.opts ? { opts: a.opts.map(scrub) } : {}) })),
      live: Number.isFinite(beat) && now.getTime() - beat < LIVE_HEARTBEAT_MS,
    };
  }

  const totals: RunView["totals"] = { seconds: steps.reduce((sum, c) => sum + (c.seconds ?? 0), 0) };
  const usage = steps.reduce<Usage | undefined>((sum, c) => (c.usage ? addUsage(sum, c.usage) : sum), undefined);
  if (usage) {
    totals.inputTokens = usage.inputTokens;
    totals.outputTokens = usage.outputTokens;
    if (usage.costUsd !== undefined) totals.costUsd = usage.costUsd;
  }

  return {
    pipeline: buildPipeline(state, started),
    tasks,
    active: steps.filter((c) => c.status === "running"),
    steps,
    routes,
    ...(waiting ? { waiting } : {}),
    ...(pr ? { pr: { ...pr, ...(ci ? { ci } : {}) } } : {}),
    totals,
    handoffs,
  };
};
