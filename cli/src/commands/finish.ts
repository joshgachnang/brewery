// Taste until the PR has no conflicts and every check passes. brewery does the waiting
// (gh watches cost no tokens) and only starts an agent when there is something to react to.
import { ping } from "../human.ts";
import { appendEvent } from "../events.ts";
import { tasteBody } from "../prompts.ts";
import { saveState } from "../state.ts";
import { runStage, type Ctx } from "../step.ts";
import type { Ci, PrSnapshot } from "../vcs.ts";
import { asksFrom, gate } from "./gate.ts";

export type Outcome = "done" | "waiting";

export const isGreen = (snap: PrSnapshot): boolean =>
  snap.mergeable !== "CONFLICTING" && snap.checks.every((c) => c.bucket === "pass" || c.bucket === "skipping");

const failureKey = (snap: PrSnapshot): string =>
  `${snap.sha}|${snap.mergeable}|${snap.checks
    .filter((c) => c.bucket === "fail" || c.bucket === "cancel")
    .map((c) => c.name)
    .sort()
    .join(",")}`;

export const finish = async (ctx: Ctx, ci: Ci, prArg?: number): Promise<Outcome> => {
  const { state, config } = ctx;
  const pr = prArg ?? state.pr ?? (await ci.prForBranch(state.repo));
  if (!pr) throw new Error("brewery: no PR for this branch. Run brew (brewery barrel) first.");
  if (!state.pr) appendEvent(state, { kind: "pr", number: pr, url: await ci.prUrl(state.repo, pr) });
  state.pr = pr;
  state.phase = "finish";
  state.finish ??= { startedAt: new Date().toISOString(), pushes: 0, reactions: 0, stuck: 0 };
  const run = state.finish;
  saveState(state);

  for (;;) {
    const hours = (Date.now() - Date.parse(run.startedAt)) / 3_600_000;
    if (hours > config.limits.finishHours) {
      await gate(ctx, [{ q: `PR #${pr} is still not green after ${hours.toFixed(1)}h. Keep going?`, rec: "retry", opts: ["retry", "stop"] }], "still not green", "Time limit reached.");
      run.startedAt = new Date().toISOString();
      saveState(state);
      return "waiting";
    }
    ctx.log(`… waiting on CI for PR #${pr}`);
    await ci.waitForChecks(state.repo, pr, config.limits.ciWaitMin);
    const snap = await ci.snapshot(state.repo, pr);
    const ciState = isGreen(snap) && !snap.checks.some((c) => c.bucket === "pending") ? "pass" :
      snap.mergeable === "CONFLICTING" || snap.checks.some((c) => c.bucket === "fail" || c.bucket === "cancel") ? "fail" : "pending";
    appendEvent(state, { kind: "ci", state: ciState });
    if (isGreen(snap) && !snap.checks.some((c) => c.bucket === "pending")) {
      state.phase = "done";
      saveState(state);
      appendEvent(state, { kind: "done" });
      ctx.log(`PASS — PR #${pr} at ${snap.sha.slice(0, 8)}: no conflicts, ${snap.checks.length} checks green.`);
      await ping(config.notify.ntfyUrl, `brewery: ${state.slug} PR #${pr} is green`);
      return "done";
    }
    const failing = snap.checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
    if (!failing.length && snap.mergeable !== "CONFLICTING") continue; // only pending: wait again

    const key = failureKey(snap);
    run.stuck = key === run.lastKey ? run.stuck + 1 : 0;
    run.lastKey = key;
    if (run.stuck >= 2) {
      const detail = `Same failure after two reactions on ${snap.sha.slice(0, 8)}: ${failing.map((c) => `${c.name} ${c.link ?? ""}`).join(", ") || "merge conflict"}.`;
      await gate(ctx, [{ q: "CI is stuck on the same failure. How should I proceed?", rec: "retry", opts: ["retry: <hint>", "stop"] }], "CI is stuck", detail);
      run.stuck = 0;
      saveState(state);
      return "waiting";
    }

    run.reactions += 1;
    const [{ result }] = await runStage(ctx, "taste", tasteBody(ctx, pr, snap));
    if (result.status === "BLOCKED") {
      await gate(ctx, asksFrom(result, result.action), "a decision on the PR", result.summary ?? result.action);
      return "waiting";
    }
    const after = await ci.snapshot(state.repo, pr);
    if (after.sha !== snap.sha) {
      run.pushes += 1;
      run.stuck = 0;
      if (run.pushes > config.limits.finishPushes) {
        await gate(ctx, [{ q: `${run.pushes} fix pushes and PR #${pr} is still red. Keep going?`, rec: "retry", opts: ["retry", "stop"] }], "too many fix pushes", result.action);
        run.pushes = 0;
        saveState(state);
        return "waiting";
      }
    }
    saveState(state);
  }
};
