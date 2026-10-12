// Apply a human reply, from any channel, then say whether the run can continue.
import { formatAsks, parseReply } from "../human.ts";
import { appendEvent } from "../events.ts";
import { parseTasks, readIp, taskGraphProblems } from "../ip.ts";
import { applyReplyBody } from "../prompts.ts";
import { appendContext, saveState } from "../state.ts";
import { runStage, type Ctx } from "../step.ts";
import { anyChanges, commitAll } from "../vcs.ts";
import { approve, cutAndFix, sendForSignoff, UnusableIpError } from "./distill.ts";

export type AnswerOutcome = "approved" | "waiting" | "continue" | "stopped";

export const answer = async (ctx: Ctx, reply: string): Promise<AnswerOutcome> => {
  const { state } = ctx;
  const waiting = state.waiting;
  if (!waiting) throw new Error(`brewery: ${state.slug} is not waiting on an answer (phase ${state.phase}).`);
  appendEvent(state, { kind: "resumed" });
  appendEvent(state, { kind: "note", text: reply });
  const at = new Date().toISOString();
  appendContext(state, `Human reply (${at.slice(0, 16)})`, `Questions asked:\n${formatAsks(waiting.asks) || "(none)"}\n\nReply:\n${reply}`);
  state.answers.push({ q: waiting.asks.map((a) => a.q).join(" / ") || waiting.message.split("\n")[0], a: reply, at });
  saveState(state);

  if (waiting.kind === "signoff") {
    const verdict = parseReply(reply);
    const [{ result }] = await runStage(ctx, "distill", applyReplyBody(ctx, waiting.asks, reply, verdict));
    // Keep the saved sign-off available until approval or a replacement is persisted.
    // Agent edits can break the graph even when reported as non-structural.
    const graphInvalid = taskGraphProblems(parseTasks(readIp(state.ip))).length > 0;
    let asks = result.ask ?? [];
    try {
      if (verdict === "reject" || result.structural || graphInvalid) {
        asks = await cutAndFix(ctx, asks, verdict === "approve" ? 1 : ctx.config.limits.cutRounds);
      }
      if (verdict === "approve") {
        approve(state);
        ctx.log(`Approved. Next: brewery barrel ${state.slug}`);
        return "approved";
      }
    } catch (error) {
      if (!(error instanceof UnusableIpError)) throw error;
      asks = [{
        q: `The IP is still unusable: ${error.problem}. How should it be repaired?`,
        rec: "Repair the IP before approving",
        opts: ["Repair the IP before approving", "Revise the plan"],
      }, ...error.asks];
    }
    // Rejected, or answers without an approval: reshape as needed and ask again.
    await sendForSignoff(ctx, asks);
    return "waiting";
  }

  const text = reply.trim().toLowerCase();
  state.waiting = undefined;
  if (text.startsWith("stop")) {
    saveState(state);
    ctx.log(`Stopped. Resume later with: brewery barrel ${state.slug}`);
    return "stopped";
  }
  const task = waiting.task ? state.tasks[waiting.task] : undefined;
  if (task) {
    if (text.startsWith("skip")) task.status = "skipped";
    else task.attempts = 0;
  }
  if (state.phase === "integrate") {
    if (text.startsWith("ship")) {
      // A blocked repair can leave edits; branch review must see their committed HEAD.
      if (await anyChanges(state.repo)) await commitAll(state.repo, "Fix integration of parallel tasks", false);
      state.phase = "review";
    } else state.integrationRounds = 0;
  }
  if (state.phase === "review" && waiting.task !== "INTEGRATE") {
    if (text.startsWith("ship")) state.phase = "brew";
    else state.reviewRounds = 0;
  }
  saveState(state);
  return "continue";
};
