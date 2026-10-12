// distill → cut/fix rounds → sign-off. The IP's Status line is brewery's alone.
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import type { Ask, Finding } from "../agents.ts";
import { buildMessage, smsVersion, waitForHuman } from "../human.ts";
import { isApproved, orientation, parseTasks, readIp, readStatus, setStatus, taskGraphProblems, title, writeIp } from "../ip.ts";
import { distillBody, fixBody } from "../prompts.ts";
import { appendContext, saveState, type RunState } from "../state.ts";
import { runStage, type Ctx } from "../step.ts";
import { runCut } from "./cut.ts";

const today = (): string => new Date().toISOString().slice(0, 10);

export class UnusableIpError extends Error {
  constructor(readonly problem: string, readonly asks: Ask[], maxRounds: number) {
    super(`brewery: distill IP remains unusable after ${maxRounds} cut rounds: ${problem}`);
    this.name = "UnusableIpError";
  }
}

export const defaultIpPath = (repo: string, slug: string): string => join(repo, "docs", "plans", `${today()}-${slug}.md`);

const ipProblems = (path: string): string | null => {
  if (!existsSync(path)) return `no IP at ${path}`;
  const text = readIp(path);
  const tasks = parseTasks(text);
  if (!tasks.length) return "IP has no task lines in the `- [ ] **T1** — title` format";
  if (readStatus(text) === null) return "IP has no `Status:` line";
  const problems = taskGraphProblems(tasks);
  if (problems.length) return problems.join("; ");
  return null;
};

const graphFindings = (path: string): Finding[] =>
  taskGraphProblems(parseTasks(readIp(path))).map((problem) => ({
    severity: "blocking",
    axis: "decomposition",
    attack: problem,
    evidence: `${path}: ${problem}`,
  }));

export const writeDraft = async (ctx: Ctx, request: string): Promise<Ask[]> => {
  const { state } = ctx;
  let lastProblem: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const [{ result }] = await runStage(ctx, "distill", distillBody(ctx, request, state.ip));
    if (result.ip) state.ip = isAbsolute(result.ip) ? result.ip : join(state.repo, result.ip);
    const problem = ipProblems(state.ip);
    lastProblem = problem;
    if (result.status === "PASS" && !problem) {
      saveState(state);
      return result.ask ?? [];
    }
    if (result.status === "BLOCKED" && !problem) return result.ask ?? [];
    ctx.log(`  distill attempt ${attempt} unusable: ${problem ?? result.action}`);
  }
  throw new Error(`brewery: distill did not produce a usable IP at ${state.ip}${lastProblem ? `: ${lastProblem}` : ""}`);
};

// Recut structural fixes and invalid graphs, bounded by maxRounds.
export const cutAndFix = async (ctx: Ctx, asks: Ask[], maxRounds: number): Promise<Ask[]> => {
  let current = asks;
  for (let round = 1; round <= maxRounds; round++) {
    ctx.state.cutRounds += 1;
    const findings = [...await runCut(ctx), ...graphFindings(ctx.state.ip)];
    if (!findings.length) break;
    const [{ result }] = await runStage(ctx, "distill", fixBody(ctx, findings));
    if (result.ask) current = result.ask;
    const blocking = findings.some((f) => f.severity === "blocking");
    const graphInvalid = graphFindings(ctx.state.ip).length > 0;
    if (!(graphInvalid || (blocking && result.structural))) break;
  }
  saveState(ctx.state);
  const problem = ipProblems(ctx.state.ip);
  if (problem) throw new UnusableIpError(problem, current, maxRounds);
  return current;
};

export const sendForSignoff = async (ctx: Ctx, asks: Ask[]): Promise<void> => {
  const { state } = ctx;
  const channel = ctx.config.notify.ntfyUrl ? "ntfy + terminal" : "terminal";
  writeIp(state.ip, setStatus(readIp(state.ip), `awaiting sign-off (sent ${today()} via ${channel})`));
  state.phase = "signoff";
  const text = readIp(state.ip);
  const parts = {
    repoName: basename(state.repo),
    title: title(text),
    need: "plan ready for sign-off",
    orientation: orientation(text),
    link: relative(state.repo, state.ip),
    asks,
    replyHint: `Reply "ok" to accept every recommendation, or e.g. "ok, 2b" / "no: <why>".`,
  };
  const message = buildMessage(parts);
  await waitForHuman(state, "signoff", asks, message, ctx.config.notify.ntfyUrl, ctx.log);
  ctx.log(`SMS version: ${smsVersion(parts, state.slug)}`);
};

export const approve = (state: RunState): void => {
  writeIp(state.ip, setStatus(readIp(state.ip), `approved ${today()}`));
  state.phase = "approved";
  state.waiting = undefined;
  saveState(state);
};

export const distill = async (ctx: Ctx, request: string): Promise<void> => {
  const { state } = ctx;
  if (!state.request) appendContext(state, "Original request", request);
  state.request = request;
  saveState(state);
  let asks = await writeDraft(ctx, request);
  if (isApproved(readIp(state.ip))) {
    // An agent must never approve; undo it.
    writeIp(state.ip, setStatus(readIp(state.ip), "draft"));
  }
  asks = await cutAndFix(ctx, asks, ctx.config.limits.cutRounds);
  await sendForSignoff(ctx, asks);
};
