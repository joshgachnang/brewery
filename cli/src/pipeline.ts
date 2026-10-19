// The vendored terreno skills and zerg read .terreno/pipeline/<slug>.json
// (terreno-shared/execution-state.schema.json). brewery's own state stays the source of
// truth; this is a projection of it, rewritten on every save.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Phase, RunState } from "./state.ts";

export type TerrenoStage = "grow" | "pick" | "roast" | "brew" | "taste";

const PHASE_STAGE: Record<Phase, TerrenoStage> = {
  distill: "grow",
  signoff: "grow",
  approved: "pick",
  build: "pick",
  integrate: "roast",
  review: "roast",
  brew: "brew",
  finish: "taste",
  done: "taste",
};

// brewery's step names → terreno stages. Cut is part of grow; the branch review is a roast.
const STEP_STAGE: Record<string, TerrenoStage> = {
  distill: "grow",
  cut: "grow",
  pick: "pick",
  roast: "roast",
  review: "roast",
  brew: "brew",
  taste: "taste",
  compound: "taste",
  approve: "roast",
};

export interface LedgerEntry {
  task: string;
  stage: "pick" | "roast";
  attempt: number;
  sha: string;
  status: "PASS" | "FAIL" | "BLOCKED";
  summary: string;
  ev: string;
}

export interface ExecutionState {
  v: 2;
  ip?: string;
  task?: string;
  stage: TerrenoStage;
  attempt: number;
  branch?: string;
  pr?: string;
  artifacts: string[];
  ledger: LedgerEntry[];
  next: { stage: TerrenoStage | null; why: string; human: boolean };
}

export const pipelinePath = (repo: string, slug: string): string => join(repo, ".terreno", "pipeline", `${slug}.json`);

const ledger = (state: RunState): LedgerEntry[] => {
  const attempts = new Map<string, number>();
  const out: LedgerEntry[] = [];
  for (const h of state.history) {
    if (!h.task || (h.stage !== "pick" && h.stage !== "roast") || h.status === "PENDING") continue;
    const key = `${h.task}|${h.stage}`;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    out.push({
      task: h.task,
      stage: h.stage,
      attempt,
      sha: state.tasks[h.task]?.commit ?? "",
      status: h.status,
      summary: h.action,
      ev: relative(state.repo, h.log),
    });
  }
  return out;
};

export const projectPipeline = (state: RunState): ExecutionState => {
  const last = state.history.at(-1);
  // During build the last step tells pick from roast.
  const stage = state.phase === "build" && last?.stage === "roast" ? "roast" : PHASE_STAGE[state.phase];
  const task = state.phase === "build"
    ? (Object.entries(state.tasks).find(([, t]) => t.status === "running") ?? Object.entries(state.tasks).find(([, t]) => t.status === "todo"))?.[0]
    : undefined;
  const attempt = task
    ? Math.max(1, state.tasks[task].attempts)
    : Math.max(1, state.history.filter((h) => STEP_STAGE[h.stage] === stage).length);
  let next: ExecutionState["next"];
  if (state.phase === "done") next = { stage: null, why: "PR is green", human: false };
  else if (state.waiting) next = { stage, why: state.waiting.message.split("\n")[0].slice(0, 200), human: true };
  else if (state.phase === "approved") next = { stage: "pick", why: "approved; barrel not started", human: false };
  else next = { stage, why: `${state.phase} in progress`, human: false };
  return {
    v: 2,
    ...(state.ip ? { ip: relative(state.repo, state.ip) } : {}),
    ...(task ? { task } : {}),
    stage,
    attempt,
    ...(state.branch ? { branch: state.branch } : {}),
    ...(state.pr ? { pr: String(state.pr) } : {}),
    artifacts: [relative(state.repo, join(state.repo, ".terreno", "brewery", state.slug))],
    ledger: ledger(state),
    next,
  };
};

export const writePipeline = (state: RunState): void => {
  const path = pipelinePath(state.repo, state.slug);
  mkdirSync(join(state.repo, ".terreno", "pipeline"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(projectPipeline(state), null, 2)}\n`);
};
