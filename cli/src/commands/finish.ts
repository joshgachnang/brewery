// Taste until the PR has no conflicts and every check passes. brewery does the waiting
// (waiting on the forge costs no tokens) and only starts an agent when there is something to react to.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { recordFailures, resolveFailures } from "../ci.ts";
import { ping } from "../human.ts";
import { recordRun } from "../learn.ts";
import { appendEvent } from "../events.ts";
import { tasteBody } from "../prompts.ts";
import { recoverEnvironment } from "../recover.ts";
import { saveState } from "../state.ts";
import { runStage, type Ctx } from "../step.ts";
import type { Ci, PrSnapshot } from "../vcs.ts";
import { asksFrom, gate } from "./gate.ts";

export type Outcome = "done" | "waiting";

// A repo with CI workflows whose PR reports no check at all has not passed CI: its jobs were
// never started (an Actions budget, a missing runner) or the forge could not list them. `[].every()`
// is true, so without this an empty list read as "0 checks green".
const checksGreen = (snap: PrSnapshot, ciExpected: boolean): boolean =>
  snap.mergeable !== "CONFLICTING" &&
  !(ciExpected && snap.checks.length === 0) &&
  snap.checks.every((c) => c.bucket === "pass" || c.bucket === "skipping");

// Done means green checks and no bot comment left unanswered, not just green checks.
export const isGreen = (snap: PrSnapshot, ciExpected = true): boolean => checksGreen(snap, ciExpected) && !snap.botThreads?.length;

const CI_CONFIG_DIRS = [".github/workflows", ".forgejo/workflows", ".circleci", ".buildkite"];

// Whether the repo defines CI at all; one that does not can only ever report zero checks.
export const ciConfigured = (repo: string): boolean =>
  CI_CONFIG_DIRS.some((dir) => {
    try {
      return readdirSync(join(repo, dir)).length > 0;
    } catch {
      return false;
    }
  });

const failureKey = (snap: PrSnapshot): string =>
  `${snap.sha}|${snap.mergeable}|${snap.checks
    .filter((c) => c.bucket === "fail" || c.bucket === "cancel")
    .map((c) => c.name)
    .sort()
    .join(",")}|${(snap.botThreads ?? []).map((t) => t.id).sort().join(",")}`;

export const finish = async (ctx: Ctx, ci: Ci, prArg?: number): Promise<Outcome> => {
  const { state, config } = ctx;
  const pr = prArg ?? state.pr ?? (await ci.prForBranch(state.repo));
  if (!pr) throw new Error("brewery: no PR for this branch. Run brew (brewery barrel) first.");
  await recoverEnvironment(state, ctx.log);
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
    const ciExpected = !run.noChecksOk && ciConfigured(state.repo);
    // No check on a repo that has CI: wait for registration a few times, then ask, never pass.
    if (ciExpected && snap.checks.length === 0 && snap.mergeable !== "CONFLICTING") {
      run.emptyChecks = (run.emptyChecks ?? 0) + 1;
      saveState(state);
      if (run.emptyChecks >= 3) {
        run.emptyChecks = 0;
        await gate(
          ctx,
          [{ q: `PR #${pr} reports no CI checks although the repo defines CI. Fix whatever stops the jobs from starting, or tell me none are expected?`, rec: "retry", opts: ["retry", "accept: no checks are expected", "stop"] }],
          "no CI checks reported",
          `GitHub lists no checks for ${snap.sha.slice(0, 8)}. Jobs refused before they start (an Actions spending budget, no runner) look exactly like this.`,
        );
        saveState(state);
        return "waiting";
      }
      continue;
    }
    run.emptyChecks = 0;
    const ciState = checksGreen(snap, ciExpected) && !snap.checks.some((c) => c.bucket === "pending") ? "pass" :
      snap.mergeable === "CONFLICTING" || snap.checks.some((c) => c.bucket === "fail" || c.bucket === "cancel") ? "fail" : "pending";
    appendEvent(state, { kind: "ci", state: ciState });
    if (isGreen(snap, ciExpected) && !snap.checks.some((c) => c.bucket === "pending")) {
      resolveFailures(state, snap.sha);
      if (!run.recorded) {
        run.recorded = true;
        saveState(state);
        // The journal push moves the head, so wait for green on the new one.
        if ((await recordRun(ctx)) === "recorded") continue;
      }
      state.phase = "done";
      saveState(state);
      appendEvent(state, { kind: "done" });
      ctx.log(`PASS — PR #${pr} at ${snap.sha.slice(0, 8)}: no conflicts, ${snap.checks.length} checks green.`);
      await ping(config.notify.ntfyUrl, `brewery: ${state.slug} PR #${pr} is green`);
      return "done";
    }
    const failing = snap.checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
    if (!failing.length && snap.mergeable !== "CONFLICTING" && !snap.botThreads?.length) continue; // only pending: wait again
    await recordFailures(state, ci, snap.sha, failing);

    const key = failureKey(snap);
    run.stuck = key === run.lastKey ? run.stuck + 1 : 0;
    run.lastKey = key;
    if (run.stuck >= 2) {
      const detail = `Same failure after two reactions on ${snap.sha.slice(0, 8)}: ${failing.map((c) => `${c.name} ${c.link ?? ""}`).join(", ") || (snap.mergeable === "CONFLICTING" ? "merge conflict" : `${snap.botThreads?.length ?? 0} unanswered bot threads`)}.`;
      await gate(ctx, [{ q: "CI is stuck on the same failure. How should I proceed?", rec: "retry", opts: ["retry: <hint>", "stop"] }], "CI is stuck", detail);
      run.stuck = 0;
      saveState(state);
      return "waiting";
    }

    // Three fix rounds that left the PR red: escalate instead of starting a fourth.
    if (run.pushes >= config.limits.finishPushes) {
      await gate(ctx, [{ q: `BLOCKED — PR #${pr} still red after ${run.pushes} fix rounds. Keep going?`, rec: "retry", opts: ["retry", "stop"] }], "too many fix pushes", `Still failing on ${snap.sha.slice(0, 8)}: ${failing.map((c) => `${c.name} ${c.link ?? ""}`).join(", ") || "merge conflict or unanswered bot threads"}.`);
      run.pushes = 0;
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
    }
    saveState(state);
  }
};
