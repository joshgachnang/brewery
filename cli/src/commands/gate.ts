// Raise a human gate mid-run: one message, a content-free ping, and the run stops.
import { basename, relative } from "node:path";
import type { Ask, StepResult } from "../agents.ts";
import { buildMessage, waitForHuman } from "../human.ts";
import { readIp, title } from "../ip.ts";
import { saveState } from "../state.ts";
import type { Ctx } from "../step.ts";

export const asksFrom = (result: StepResult, fallback: string): Ask[] => {
  if (result.ask?.length) return result.ask;
  const why = result.block?.map((b) => `${b.kind}: ${b.why}`).join("; ") || fallback;
  return [{ q: `${why}. What should I do?`, rec: "retry", opts: ["retry", "stop"] }];
};

export const gate = async (ctx: Ctx, asks: Ask[], need: string, detail: string, task?: string): Promise<void> => {
  const { state } = ctx;
  let planTitle = state.slug;
  try {
    planTitle = state.ip ? title(readIp(state.ip)) : state.slug;
  } catch {
    // Standalone finish runs have no IP.
  }
  const message = buildMessage({
    repoName: basename(state.repo),
    title: planTitle,
    need,
    orientation: detail,
    link: state.pr ? `PR #${state.pr}` : relative(state.repo, state.ip),
    asks,
    replyHint: `Reply with a choice (e.g. "1a"), "retry: <hint>", "skip", or "stop".`,
  });
  await waitForHuman(state, "gate", asks, message, ctx.config.notify.ntfyUrl, ctx.log);
  if (state.waiting && task) {
    state.waiting.task = task;
    saveState(state);
  }
};
