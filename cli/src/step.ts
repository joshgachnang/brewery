// Run one stage: pick its agent(s), give each a fresh process with a written prompt,
// collect their result files, and record every run in history.
import { join } from "node:path";
import { availability, runAgent, type StepResult } from "./agents.ts";
import { FAN_OUT, type Config, type Stage } from "./config.ts";
import { appendEvent } from "./events.ts";
import { header } from "./prompts.ts";
import { runDir, saveState, type RunState } from "./state.ts";

export interface Ctx {
  state: RunState;
  config: Config;
  log: (line: string) => void;
}

export interface AgentResult {
  agent: string;
  result: StepResult;
}

const availabilityCache = new Map<string, Promise<string | null>>();

const checkAgent = (config: Config, name: string): Promise<string | null> => {
  if (!availabilityCache.has(name)) availabilityCache.set(name, availability(config.agents[name]));
  return availabilityCache.get(name) as Promise<string | null>;
};

export const resolveAgents = async (ctx: Ctx, stage: Stage): Promise<string[]> => {
  const wanted = ctx.config.stages[stage];
  const ok: string[] = [];
  for (const name of wanted) {
    const problem = await checkAgent(ctx.config, name);
    if (problem) ctx.log(`  skip ${name} for ${stage}: ${problem}`);
    else ok.push(name);
    if (ok.length && !FAN_OUT.has(stage)) break;
  }
  if (!ok.length) throw new Error(`brewery: no available agent for ${stage} (tried ${wanted.join(", ")})`);
  return ok;
};

export interface StageOptions {
  task?: string;
  cwd?: string;
  parallel?: boolean;
}

export const runStage = async (ctx: Ctx, stage: Stage, body: string, opts: StageOptions = {}): Promise<AgentResult[]> => {
  const agents = await resolveAgents(ctx, stage);
  const { state, config } = ctx;
  const runOne = async (agent: string): Promise<AgentResult> => {
    state.seq += 1;
    const seq = state.seq;
    // Reserve the ID durably before any externally visible event or agent output.
    saveState(state);
    const base = join(runDir(state.repo, state.slug), "steps", `${String(seq).padStart(3, "0")}-${stage}${opts.task ? `-${opts.task}` : ""}-${agent}`);
    const resultFile = `${base}.result.json`;
    const label = `${stage}${opts.task ? ` ${opts.task}` : ""} (${agent})`;
    ctx.log(`▸ ${label}`);
    appendEvent(state, { kind: "step.start", seq, stage, ...(opts.task ? { task: opts.task } : {}), agent });
    const outcome = await runAgent({
      name: label,
      profile: config.agents[agent],
      cwd: opts.cwd ?? state.repo,
      prompt: `${header(opts.cwd ? { ...ctx, state: { ...state, repo: opts.cwd } } : ctx, resultFile)}\n\n${body}`,
      promptFile: `${base}.prompt.md`,
      resultFile,
      logFile: `${base}.log`,
      timeoutMin: config.agents[agent].timeoutMin ?? config.limits.stepTimeoutMin,
      onNarration: (text) => appendEvent(state, { kind: "narration", seq, text }),
    });
    ctx.log(`  ${label}: ${outcome.result.status} in ${outcome.seconds}s — ${outcome.result.action}`);
    appendEvent(state, { kind: "step.end", seq, status: outcome.result.status, action: outcome.result.action, seconds: outcome.seconds });
    state.history.push({
      seq,
      stage,
      agent,
      status: outcome.result.status,
      action: outcome.result.action,
      seconds: outcome.seconds,
      log: `${base}.log`,
      task: opts.task,
    });
    saveState(state);
    return { agent, result: outcome.result };
  };
  if (opts.parallel) return Promise.all(agents.map(runOne));
  const results: AgentResult[] = [];
  for (const agent of agents) results.push(await runOne(agent));
  return results;
};

// Fan-out verdict: any FAIL fails, then any BLOCKED blocks, else PASS. Evidence is pooled.
export const mergeVerdicts = (results: AgentResult[]): StepResult => {
  const failing = results.filter((r) => r.result.status === "FAIL");
  const blocked = results.filter((r) => r.result.status === "BLOCKED");
  const worst = failing.length ? failing : blocked;
  if (!worst.length) {
    return { status: "PASS", action: results.map((r) => `${r.agent}: ${r.result.action}`).join(" | ") };
  }
  return {
    status: failing.length ? "FAIL" : "BLOCKED",
    action: worst.map((r) => `${r.agent}: ${r.result.action}`).join(" | "),
    fail: worst.flatMap((r) => (r.result.fail ?? []).map((f) => ({ ...f, ev: `[${r.agent}] ${f.ev}` }))),
    block: worst.flatMap((r) => r.result.block ?? []),
    ask: worst.flatMap((r) => r.result.ask ?? []),
  };
};

export const evidenceText = (result: StepResult): string =>
  JSON.stringify({ action: result.action, fail: result.fail, block: result.block, summary: result.summary }, null, 2);
