// Route the handoff briefs earlier steps wrote into the prompts of the steps that need them.
// The table is fixed: which steps a receiver reads depends only on its stage and task.
import { existsSync, readFileSync } from "node:fs";
import { cleanHandoff, type Handoff, type Status } from "./agents.ts";
import type { HistoryEntry, RunState } from "./state.ts";

// Stages whose steps are asked to write a handoff. Every other stage writes none.
export const SOURCE_STAGES: ReadonlySet<string> = new Set(["test", "pick", "roast", "brew", "taste"]);

// Fix steps that run after the per-task loop. They are not tasks of their own.
const FIX_TASKS: ReadonlySet<string> = new Set(["INTEGRATE", "REVIEW"]);

// No step receives more than this many handoffs; the newest win.
export const MAX_HANDOFFS = 6;

export const CLAIMS_LINE = "Claims from the implementer: verify them, do not trust them.";
export const HANDOFFS_HEADING = "## Handoffs from earlier steps";

export interface RoutedHandoff {
  seq: number;
  stage: string;
  task?: string;
  agent: string;
  status: Status;
  handoff: Partial<Handoff>;
}

type Pick = (history: HistoryEntry[]) => HistoryEntry[];

const latest = (entries: HistoryEntry[]): HistoryEntry[] => entries.slice(-1);
const isStage = (stage: string, task?: string) => (entry: HistoryEntry): boolean =>
  entry.stage === stage && (task === undefined || entry.task === task);

// Each real task's last passing pick, in seq order.
const lastPassingPicks: Pick = (history) => {
  const byTask = new Map<string, HistoryEntry>();
  for (const entry of history) {
    if (entry.stage !== "pick" || entry.status !== "PASS" || !entry.task || FIX_TASKS.has(entry.task)) continue;
    // Delete first so a re-passed task moves to the end and the map stays in seq order.
    byTask.delete(entry.task);
    byTask.set(entry.task, entry);
  }
  return [...byTask.values()];
};

// Which earlier steps a receiver reads, and whether it gets only the verifiable claims.
const route = (stage: string, task?: string): { sources: Pick; claimsOnly: boolean } | undefined => {
  if (stage === "pick" && task === "INTEGRATE") return { sources: lastPassingPicks, claimsOnly: false };
  if (stage === "pick" && task === "REVIEW") return { sources: lastPassingPicks, claimsOnly: false };
  if (stage === "roast" && task === "INTEGRATE") return { sources: lastPassingPicks, claimsOnly: true };
  if (stage === "roast" && task === "REVIEW") return { sources: (h) => latest(h.filter(isStage("pick", "REVIEW"))), claimsOnly: true };
  if (stage === "pick" && task) {
    // The newest tests, plus every earlier attempt at this task and its verdicts (retries).
    const sources: Pick = (h) => {
      const [tests] = latest(h.filter(isStage("test", task)));
      return h.filter((e) => e === tests || isStage("pick", task)(e) || isStage("roast", task)(e));
    };
    return { sources, claimsOnly: false };
  }
  if (stage === "roast" && task) return { sources: (h) => latest(h.filter(isStage("pick", task))), claimsOnly: true };
  if (stage === "brew") return { sources: lastPassingPicks, claimsOnly: false };
  if (stage === "taste") {
    const sources: Pick = (h) => {
      const [brew] = latest(h.filter(isStage("brew")));
      return h.filter((e) => e === brew || e.stage === "taste");
    };
    return { sources, claimsOnly: false };
  }
  return undefined;
};

// The result file sits beside the step's log; history records the log path.
const readHandoff = (entry: HistoryEntry): Handoff | undefined => {
  const file = entry.log.replace(/\.log$/, ".result.json");
  if (!existsSync(file)) return undefined;
  try {
    return cleanHandoff((JSON.parse(readFileSync(file, "utf8")) as { handoff?: unknown }).handoff);
  } catch {
    return undefined;
  }
};

export const handoffsFor = (state: RunState, query: { stage: string; task?: string }): RoutedHandoff[] => {
  const rule = route(query.stage, query.task);
  if (!rule) return [];
  const history = [...state.history].sort((a, b) => a.seq - b.seq);
  const routed: RoutedHandoff[] = [];
  for (const entry of rule.sources(history)) {
    const handoff = readHandoff(entry);
    if (!handoff) continue;
    routed.push({
      seq: entry.seq,
      stage: entry.stage,
      ...(entry.task ? { task: entry.task } : {}),
      agent: entry.agent,
      status: entry.status,
      handoff: rule.claimsOnly ? { files: handoff.files, traps: handoff.traps } : handoff,
    });
  }
  return routed.slice(-MAX_HANDOFFS);
};

// Roast's copy carries only files and traps, so its section opens with the claims label.
export const handoffSection = (routed: RoutedHandoff[], claimsOnly: boolean): string => {
  if (!routed.length) return "";
  const list = (label: string, items?: string[]): string =>
    items?.length ? `${label}:\n${items.map((item) => `- ${item}`).join("\n")}\n` : "";
  const entries = routed.map((r) => {
    const source = `### Step ${r.seq}: ${r.stage}${r.task ? ` ${r.task}` : ""} (${r.agent}), ${r.status}`;
    const did = r.handoff.did ? `Did: ${r.handoff.did}\n` : "";
    return `${source}\n${did}${list("Learned", r.handoff.learned)}${list("Traps", r.handoff.traps)}${list("Files", r.handoff.files)}`;
  });
  return `${HANDOFFS_HEADING}\n\n${claimsOnly ? `${CLAIMS_LINE}\n\n` : ""}${entries.join("\n")}`;
};

export const isClaimsOnly = (stage: string, task?: string): boolean => Boolean(route(stage, task)?.claimsOnly);
