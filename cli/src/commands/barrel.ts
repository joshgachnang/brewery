// Approved IP → green PR. Each Pick, each Roast, the branch review, and Brew are
// separate agent processes; brewery commits between them so Roast judges a fixed tree.
import type { Ask, Finding } from "../agents.ts";
import { isApproved, markTask, parseTasks, readyTasks, sharesFiles, taskGraphProblems, readIp, writeIp } from "../ip.ts";
import { integratedRoastBody, integrationFixBody, brewBody, pickBody, reviewBody, reviewFixBody, roastBody, roastReviewFixBody } from "../prompts.ts";
import { runDir, saveState, type TaskState } from "../state.ts";
import { appendEvent } from "../events.ts";
import { evidenceText, mergeVerdicts, runStage, type Ctx } from "../step.ts";
import { addWorktree, removeWorktreeStrict, anyChanges, commitAll, currentBranch, ensureExcluded, git, headSha, sh, trackedChanges, type Ci } from "../vcs.ts";
import { finish, type Outcome } from "./finish.ts";
import { asksFrom, gate } from "./gate.ts";
import { dirname, join, relative } from "node:path";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";

const ensureBranch = async (ctx: Ctx): Promise<void> => {
  const { state } = ctx;
  const branch = state.branch ?? state.slug;
  const current = await currentBranch(state.repo);
  if (current === branch) {
    state.branch = branch;
    return;
  }
  if (current !== state.base) {
    throw new Error(`brewery: on branch ${current}. Switch to ${state.base} or ${branch} first.`);
  }
  const ipRel = relative(state.repo, state.ip);
  const stray = (await trackedChanges(state.repo)).filter((line) => !line.endsWith(ipRel));
  if (stray.length) throw new Error(`brewery: uncommitted changes on ${current}:\n${stray.join("\n")}`);
  const exists = (await sh(state.repo, ["git", "rev-parse", "--verify", "--quiet", branch])).code === 0;
  await git(state.repo, "checkout", ...(exists ? [branch] : ["-b", branch]));
  state.branch = branch;
  ctx.log(`on branch ${branch}`);
};

type StepOutcome = "next" | "waiting";
type TaskGate = { asks: Ask[]; need: string; detail: string };
type BuildResult = { gate?: TaskGate };

// A crash between cherry-pick and the checked/amended commit must not leave
// partial credit on the feature branch. Only the serial land queue owns this journal.
const recoverLanding = async (ctx: Ctx): Promise<void> => {
  const { state } = ctx;
  const landing = state.landing;
  if (!landing) return;
  const active = await sh(state.repo, ["git", "rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"]);
  if (active.code === 0) await git(state.repo, "cherry-pick", "--abort");
  try {
    // Preflight failures did not move HEAD; leave unrelated working files alone.
    // On interrupted land, --merge preserves unrelated unstaged edits.
    if ((await headSha(state.repo)) !== landing.head) await git(state.repo, "reset", "--merge", landing.head);
  } finally {
    writeIp(state.ip, landing.ip);
  }
  if (landing.index) {
    const { mode, sha, path } = landing.index;
    await git(state.repo, "update-index", "--cacheinfo", mode, sha, path);
  }
  state.landing = undefined;
  saveState(state);
};

const land = async (ctx: Ctx, id: string, taskTitle: string, ts: TaskState): Promise<boolean> => {
  const { state } = ctx;
  if (!ts.commit) throw new Error(`brewery: ${id} has no commit to land`);
  const ip = readIp(state.ip);
  const ipRel = relative(state.repo, state.ip);
  const index = await git(state.repo, "ls-files", "--stage", "--", ipRel);
  const tracked = /^(\d+) ([a-f0-9]+) 0\t/.exec(index);
  const stray = (await trackedChanges(state.repo)).filter((line) => !line.endsWith(ipRel));
  if (stray.length) throw new Error(`brewery: uncommitted changes on the feature branch before land ${id}:\n${stray.join("\n")}`);
  state.landing = {
    task: id, head: await headSha(state.repo), ip,
    index: tracked ? { mode: tracked[1], sha: tracked[2], path: ipRel } : undefined,
  };
  saveState(state);
  // Approval edits belong in the task commit. Move them out of the way while
  // cherry-picking the worktree's copy, preserving them if landing fails.
  if (tracked) await git(state.repo, "restore", "--source=HEAD", "--staged", "--worktree", "--", ipRel);
  else unlinkSync(state.ip);
  const picked = await sh(state.repo, ["git", "cherry-pick", ts.commit]);
  if (picked.code !== 0) {
    let paths = (await git(state.repo, "diff", "--name-only", "--diff-filter=U")).split("\n").filter(Boolean);
    // Concurrent worktrees carry older task checkboxes. Reconcile only that
    // bookkeeping; substantive IP edits remain real conflicts and get rebuilt.
    const taskIp = await git(ts.worktree!, "show", `${ts.commit}:${ipRel}`);
    const withoutMarks = (text: string) => text.replace(/^(\s*- )\[[ xX]\]/gm, "$1[ ]").trim();
    if (paths.includes(ipRel) && withoutMarks(taskIp) === withoutMarks(ip)) {
      writeIp(state.ip, ip);
      await git(state.repo, "add", "--", ipRel);
      paths = paths.filter((path) => path !== ipRel);
    }
    if (!paths.length && picked.out.includes("CONFLICT")) {
      await git(state.repo, "-c", "core.editor=true", "cherry-pick", "--continue");
    } else {
      const aborted = await sh(state.repo, ["git", "cherry-pick", "--abort"]);
      writeIp(state.ip, ip);
      if (tracked) await git(state.repo, "update-index", "--cacheinfo", tracked[1], tracked[2], ipRel);
      if (!paths.length || aborted.code !== 0) throw new Error(`brewery: land ${id} failed: ${picked.err || picked.out}`);
      const earlier: string[] = [];
      for (const [otherId, other] of Object.entries(state.tasks)) {
        if (other.status !== "passed" || !other.commit) continue;
        const touched = (await git(state.repo, "diff-tree", "--no-commit-id", "--name-only", "-r", other.commit)).split("\n");
        if (paths.some((path) => touched.includes(path))) earlier.push(otherId);
      }
      ts.evidence = `Land conflict: ${paths.join(", ")}; rebuild on the new head; ${earlier.join(", ") || "another task"} landed first and touched these`;
      ctx.log(`  ${id}: ${ts.evidence}`);
      state.landing = undefined;
      return false;
    }
  }
  writeIp(state.ip, markTask(readIp(state.ip), id));
  ts.commit = await commitAll(state.repo, taskTitle, true);
  ts.status = "passed";
  ts.evidence = undefined;
  state.landing = undefined;
  saveState(state);
  return true;
};

const taskContext = (ctx: Ctx, cwd: string): Ctx => {
  const skillsRel = relative(ctx.state.repo, ctx.config.skillsDir);
  return {
    ...ctx,
    state: { ...ctx.state, repo: cwd, ip: join(cwd, relative(ctx.state.repo, ctx.state.ip)) },
    config: {
      ...ctx.config,
      skillsDir: skillsRel.startsWith("..") ? ctx.config.skillsDir : join(cwd, skillsRel),
    },
  };
};

const buildTask = async (ctx: Ctx, cwd: string, id: string, taskTitle: string, ts: TaskState, approvedIp: string): Promise<BuildResult> => {
  const { state, config } = ctx;
  let needsCleanup = ts.evidence?.startsWith("Worktree setup FAIL") || ts.evidence?.startsWith("Interrupted build") || ts.evidence?.startsWith("Land conflict:");
  for (;;) {
    if (ts.attempts >= config.limits.pickAttempts) {
      const last = ts.evidence?.slice(0, 600) ?? "no evidence recorded";
      return { gate: {
        asks: [{ q: `${id} (${taskTitle}) failed ${ts.attempts} attempts. How should I proceed?`, rec: "retry: <a hint>", opts: ["retry: <a hint>", "skip", "stop"] }],
        need: `${id} is stuck`, detail: `Last failure: ${last}`,
      } };
    }
    ts.attempts += 1;
    saveState(state);

    // A failed setup tree cannot be reused, even when its removal also failed.
    if (needsCleanup) {
      needsCleanup = !(await cleanupTask(ctx, id));
      saveState(state);
      if (needsCleanup) continue;
    }
    const branch = `brewery/${state.slug}/${id}`;
    ts.worktree = cwd;
    ts.branch = branch;
    const taskCtx = taskContext(ctx, cwd);
    if (!existsSync(cwd)) {
      await addWorktree(state.repo, cwd, branch, await headSha(state.repo));
      // The current approved IP can have tracked edits or still be untracked.
      mkdirSync(dirname(taskCtx.state.ip), { recursive: true });
      writeIp(taskCtx.state.ip, approvedIp);
      let setupFailed = false;
      for (const command of config.worktreeSetup) {
        const setup = await sh(cwd, ["bash", "-lc", command]);
        if (setup.code === 0) continue;
        ts.evidence = `Worktree setup FAIL: ${command} (exit ${setup.code})\n${setup.out}\n${setup.err}`;
        ctx.log(`  ${ts.evidence}`);
        needsCleanup = !(await cleanupTask(ctx, id));
        saveState(state);
        setupFailed = true;
        break;
      }
      if (setupFailed) continue;
    }

    const [{ result: picked }] = await runStage(ctx, "pick", pickBody(taskCtx, id, taskTitle, ts.evidence), { task: id, cwd });
    if (picked.status === "BLOCKED") {
      return { gate: { asks: asksFrom(picked, picked.action), need: `a decision on ${id}`, detail: picked.summary ?? picked.action } };
    }
    if (picked.status !== "PASS") {
      ts.evidence = evidenceText(picked);
      continue;
    }
    if (!(await anyChanges(cwd))) {
      if (!ts.commit) {
        ts.evidence = "Pick reported PASS but changed no files.";
        continue;
      }
    } else {
      // Retries amend the task's own unpushed commit instead of stacking fix-ups.
      const amend = Boolean(ts.commit) && ts.commit === (await headSha(cwd));
      ts.commit = await commitAll(cwd, taskTitle, amend);
    }
    saveState(state);

    const verdict = mergeVerdicts(await runStage(ctx, "roast", roastBody(taskCtx, id, taskTitle, state.base), { task: id, cwd }));
    if (await anyChanges(cwd)) ctx.log(`  note: roast left changes in the tree; folding them into ${id}`);
    if (verdict.status === "PASS") {
      if (await anyChanges(cwd)) ts.commit = await commitAll(cwd, taskTitle, true);
      return {};
    }
    if (verdict.status === "BLOCKED") {
      return { gate: { asks: asksFrom(verdict, verdict.action), need: `a decision on ${id}`, detail: verdict.action } };
    }
    ts.evidence = evidenceText(verdict);
  }
};

const integrateBranch = async (ctx: Ctx): Promise<StepOutcome> => {
  const { state, config } = ctx;
  for (;;) {
    // A resumed BLOCKED Pick can retain partial repairs in the main tree.
    // Commit them before any Roast so verification always judges a fixed HEAD.
    if (await anyChanges(state.repo)) await commitAll(state.repo, "Fix integration of parallel tasks", false);
    const verdict = mergeVerdicts(await runStage(ctx, "roast", integratedRoastBody(ctx), { task: "INTEGRATE", parallel: true }));
    if (verdict.status === "PASS") return "next";
    if (verdict.status === "BLOCKED") {
      await gate(ctx, asksFrom(verdict, verdict.action), "a decision on integration", verdict.action, "INTEGRATE");
      return "waiting";
    }
    const evidence = evidenceText(verdict);
    if ((state.integrationRounds ?? 0) >= config.limits.reviewRounds) {
      await gate(ctx,
        [{ q: `Integration still fails after ${state.integrationRounds ?? 0} repair rounds. How should I proceed?`, rec: "retry", opts: ["retry", "ship", "stop"] }],
        "integration failures", evidence.slice(0, 600), "INTEGRATE");
      return "waiting";
    }
    state.integrationRounds = (state.integrationRounds ?? 0) + 1;
    saveState(state);
    const [{ result: fixed }] = await runStage(ctx, "pick", integrationFixBody(ctx, evidence), { task: "INTEGRATE" });
    if (fixed.status === "BLOCKED") {
      await gate(ctx, asksFrom(fixed, fixed.action), "a decision on integration", fixed.summary ?? fixed.action, "INTEGRATE");
      return "waiting";
    }
  }
};

const reviewBranch = async (ctx: Ctx): Promise<StepOutcome> => {
  const { state, config } = ctx;
  let open = state.reviewFindings;
  while (state.reviewPending || state.reviewRounds < config.limits.reviewRounds) {
    // An interrupted round must finish even when it is the final allowed round.
    if (!state.reviewPending) state.reviewRounds += 1;
    state.reviewPending = true;
    saveState(state);
    const results = await runStage(ctx, "review", reviewBody(ctx, state.base), { parallel: true });
    open = results.flatMap((r) => (r.result.findings ?? []).filter((f) => f.severity === "blocking").map((f) => ({ ...f, agent: r.agent })));
    for (const {agent, result} of results) {
      if (result.status !== "PASS" && !(result.findings ?? []).some((f) => f.severity === "blocking")) {
        open.push({id: `review-${agent}`, severity: "blocking", attack: `Review did not pass: ${result.action}`, evidence: evidenceText(result), agent});
      }
    }
    state.reviewFindings = open;
    saveState(state);
    ctx.log(`  review round ${state.reviewRounds}: ${open.length} blocking findings`);
    if (!open.length) {
      state.reviewPending = false;
      saveState(state);
      return "next";
    }
    const [{ result: fixed }] = await runStage(ctx, "pick", reviewFixBody(ctx, open), { task: "REVIEW" });
    if (fixed.status === "BLOCKED") {
      state.reviewPending = false;
      await gate(ctx, asksFrom(fixed, fixed.action), "a decision on review findings", fixed.summary ?? fixed.action);
      return "waiting";
    }
    if (fixed.status !== "PASS" || !(await anyChanges(state.repo))) {
      state.reviewPending = false;
      saveState(state);
      continue;
    }
    await commitAll(state.repo, "Fix issues found in branch review", false);
    const verdict = mergeVerdicts(await runStage(ctx, "roast", roastReviewFixBody(ctx, open), { task: "REVIEW" }));
    if (verdict.status === "PASS") open = [];
    state.reviewFindings = open;
    state.reviewPending = false;
    saveState(state);
  }
  if (open?.length === 0) return "next";
  await gate(
    ctx,
    [{ q: `${open?.length ?? "Unverified"} blocking review findings remain after ${state.reviewRounds} rounds. Ship anyway?`, rec: "retry", opts: ["retry", "ship", "stop"] }],
    "blocking review findings",
    open?.map((f) => `${f.where ?? ""}: ${f.attack}`).join("; ").slice(0, 600) ?? "No completed review outcome was saved. Retry review before submitting the PR.",
  );
  return "waiting";
};

const submit = async (ctx: Ctx, ci: Ci): Promise<StepOutcome> => {
  const { state } = ctx;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const [{ result }] = await runStage(ctx, "brew", brewBody(ctx, state.base));
    if (result.status === "BLOCKED") {
      await gate(ctx, asksFrom(result, result.action), "a decision before the PR", result.summary ?? result.action);
      return "waiting";
    }
    const pr = Number(result.pr) || (await ci.prForBranch(state.repo));
    if ((result.status === "PASS" || result.status === "PENDING") && pr) {
      state.pr = pr;
      saveState(state);
      appendEvent(state, { kind: "pr", number: pr, url: await ci.prUrl(state.repo, pr) });
      return "next";
    }
    ctx.log(`  brew attempt ${attempt}: ${result.action}`);
  }
  await gate(ctx, [{ q: "Brew could not open the PR twice. What should I do?", rec: "retry", opts: ["retry", "stop"] }], "PR submission failed", "See the brew logs.");
  return "waiting";
};

const cleanupTask = async (ctx: Ctx, id: string, strict = false): Promise<boolean> => {
  const ts = ctx.state.tasks[id];
  const cwd = ts.worktree ?? join(runDir(ctx.state.repo, ctx.state.slug), "worktrees", id);
  const branch = ts.branch ?? `brewery/${ctx.state.slug}/${id}`;
  try {
    if (existsSync(cwd)) await removeWorktreeStrict(ctx.state.repo, cwd);
    if ((await sh(ctx.state.repo, ["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0) {
      await git(ctx.state.repo, "branch", "-D", branch);
    }
    ts.worktree = undefined;
    ts.branch = undefined;
    return true;
  } catch (error) {
    if (strict) throw error;
    ctx.log(`  cleanup failed for ${id} (${cwd}): ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
};

const buildReadyTasks = async (ctx: Ctx): Promise<StepOutcome> => {
  const { state, config } = ctx;
  await recoverLanding(ctx);
  const tasks = parseTasks(readIp(state.ip));
  const problems = taskGraphProblems(tasks);
  if (problems.length) throw new Error(`brewery: invalid task graph: ${problems.join("; ")}`);
  const limit = config.limits.parallelTasks;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("brewery: parallelTasks must be a positive integer");
  for (const task of tasks) {
    const ts = state.tasks[task.id] ??= { status: task.done ? "passed" : "todo", attempts: 0 };
    if (ts.status === "running") {
      await cleanupTask(ctx, task.id);
      ts.status = "todo";
      ts.commit = undefined;
      ts.evidence = "Interrupted build; rebuild from the feature branch head.";
    } else if (ts.status !== "todo") await cleanupTask(ctx, task.id, ts.status === "passed");
  }
  saveState(state);
  type Completion = { id: string; result?: BuildResult; error?: unknown };
  const running = new Map<string, Promise<Completion>>();
  let firstGate: { id: string; gate: TaskGate } | undefined;
  let firstError: unknown;
  const landed = () => new Set(tasks.filter((t) => state.tasks[t.id].status === "passed" || state.tasks[t.id].status === "skipped").map((t) => t.id));
  for (;;) {
    if (!firstGate && !firstError) {
      const ready = readyTasks(tasks, landed()).filter((t) => state.tasks[t.id].status === "todo");
      const started = tasks.filter((t) => running.has(t.id));
      for (const task of ready) {
        if (running.size >= limit) break;
        // A ready task that writes a file a running task also writes would only hit a land conflict.
        if (started.some((other) => sharesFiles(task, other))) continue;
        started.push(task);
        const ts = state.tasks[task.id];
        ts.status = "running";
        ts.worktree = join(runDir(state.repo, state.slug), "worktrees", task.id);
        ts.branch = `brewery/${state.slug}/${task.id}`;
        if (running.size) state.parallelRan = true;
        saveState(state);
        ctx.log(`■ ${task.id} — ${task.title}`);
        // Capture before asynchronous startup: a sibling landing can temporarily
        // restore or remove the main IP. Include marks from tasks already landed.
        const approvedIp = readIp(state.ip);
        running.set(task.id, buildTask(ctx, ts.worktree, task.id, task.title, ts, approvedIp).then(
          (result) => {
            if (result.gate && !firstGate) firstGate = { id: task.id, gate: result.gate };
            return { id: task.id, result };
          },
          (error: unknown) => {
            firstError ??= error;
            return { id: task.id, error };
          },
        ));
      }
    }
    if (!running.size) break;
    const completed = await Promise.race(running.values());
    running.delete(completed.id);
    const ts = state.tasks[completed.id];
    if (completed.error) continue; // Leave running persisted for clean crash recovery.
    if (completed.result?.gate) {
      ts.status = "todo";
      if (firstGate?.id !== completed.id) {
        await cleanupTask(ctx, completed.id);
        ts.commit = undefined;
      }
      saveState(state);
      continue;
    }
    // Only the scheduler writes the feature branch: this is the serial land queue.
    try {
      const task = tasks.find((t) => t.id === completed.id)!;
      const passed = await land(ctx, task.id, task.title, ts);
      await cleanupTask(ctx, task.id, passed);
      if (!passed) {
        ts.status = "todo";
        ts.commit = undefined;
      }
      saveState(state);
    } catch (error) {
      firstError ??= error;
      await recoverLanding(ctx);
    }
  }
  if (firstGate) {
    const { id, gate: request } = firstGate;
    await gate(ctx, request.asks, request.need, request.detail, id);
    return "waiting";
  }
  if (firstError) throw firstError;
  if (tasks.some((t) => state.tasks[t.id].status === "todo")) {
    throw new Error("brewery: unfinished tasks have no landed dependency frontier");
  }
  return "next";
};

export const barrel = async (ctx: Ctx, ci: Ci): Promise<Outcome> => {
  const { state } = ctx;
  if (state.waiting) throw new Error(`brewery: ${state.slug} is waiting on you. Answer with: brewery answer ${state.slug} "<reply>"`);
  if (state.phase === "finish") return finish(ctx, ci);
  if (state.phase === "done") {
    ctx.log(`${state.slug} is already done (PR #${state.pr}).`);
    return "done";
  }
  if (state.landing) {
    await ensureBranch(ctx);
    await recoverLanding(ctx);
  }
  if (!isApproved(readIp(state.ip))) {
    throw new Error(`brewery: ${relative(state.repo, state.ip)} is not approved. Run distill and sign off first.`);
  }
  await ensureExcluded(state.repo);
  await ensureBranch(ctx);
  if (state.phase === "approved" || state.phase === "signoff" || state.phase === "distill") state.phase = "build";
  saveState(state);

  if (state.phase === "build") {
    if ((await buildReadyTasks(ctx)) === "waiting") return "waiting";
    // Always integrate: it is the one step that runs e2e and browser suites.
    state.phase = "integrate";
    saveState(state);
  }
  if (state.phase === "integrate") {
    if ((await integrateBranch(ctx)) === "waiting") return "waiting";
    state.phase = "review";
    saveState(state);
  }
  if (state.phase === "review") {
    if ((await reviewBranch(ctx)) === "waiting") return "waiting";
    state.phase = "brew";
    saveState(state);
  }
  if (state.phase === "brew") {
    if ((await submit(ctx, ci)) === "waiting") return "waiting";
    state.phase = "finish";
    saveState(state);
  }
  return finish(ctx, ci);
};
