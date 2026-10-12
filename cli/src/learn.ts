// End of a run: one compound step (at most one learning, only when the run struggled),
// then the journal, committed together and pushed once.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { readFailures } from "./ci.ts";
import { promoteDecisions } from "./decisions.ts";
import { RULES_PATH } from "./docs.ts";
import { JOURNAL_DIR, journalPath, renderJournal, stepFails } from "./journal.ts";
import { compoundBody } from "./prompts.ts";
import type { RunState } from "./state.ts";
import { runStage, type Ctx } from "./step.ts";
import { anyChanges, commitAll, currentBranch, git, sh } from "./vcs.ts";

const LEARNINGS = "docs/learnings/";
const PLAIN_REPLIES = /^(ok|okay|approve[d]?|yes|y|skip|ship|stop|retry)\.?$/i;

// What went wrong this run, as plain text for the compound agent. Empty when nothing did.
export const struggles = (state: RunState): string => {
  const parts: string[] = [];
  for (const [id, t] of Object.entries(state.tasks)) {
    const fails = state.history.filter((h) => h.task === id && h.status === "FAIL");
    if (!fails.length && t.status !== "skipped") continue;
    parts.push(`### Task ${id} (${t.status}, ${t.attempts} attempts${t.commit ? `, final commit ${t.commit.slice(0, 8)}` : ""})`);
    for (const h of fails) {
      parts.push(`- ${h.stage} (${h.agent}) FAILED: ${h.action}`);
      for (const f of stepFails(h.log)) parts.push(`  - ${f}`);
    }
  }
  const review = state.history.filter((h) => h.task === "REVIEW");
  if (review.length) {
    parts.push("### Branch review findings that needed fixes");
    for (const h of review) parts.push(`- ${h.stage} (${h.agent}) ${h.status}: ${h.action}`);
  }
  const fixed = readFailures(state).filter(({ failure }) => failure.status === "fixed");
  if (fixed.length) {
    parts.push("### CI failures fixed during finish");
    for (const { failure: f } of fixed) {
      parts.push(`- ${f.check} failed at ${f.sha.slice(0, 8)}, fixed by ${f.fixSha?.slice(0, 8)} (\`git log ${f.sha.slice(0, 8)}..${f.fixSha?.slice(0, 8)}\`)`);
      if (f.log) parts.push("~~~", f.log.split("\n").slice(-40).join("\n"), "~~~");
    }
  }
  const hints = state.answers.filter((a) => !PLAIN_REPLIES.test(a.a.trim()));
  if (hints.length) {
    parts.push("### What the human said when asked (corrections are the strongest signal)");
    for (const a of hints) parts.push(`- Q: ${a.q}`, `  A: ${a.a}`);
  }
  return parts.join("\n");
};

const lines = (text: string): string[] => text.split("\n").filter(Boolean);

export const changedPaths = async (repo: string): Promise<{ path: string; untracked: boolean }[]> => [
  ...lines(await git(repo, "diff", "--name-only", "HEAD")).map((path) => ({ path, untracked: false })),
  ...lines(await git(repo, "ls-files", "--others", "--exclude-standard")).map((path) => ({ path, untracked: true })),
];

export const isLearning = (path: string): boolean =>
  path.startsWith(LEARNINGS) && path.endsWith(".md") && path !== RULES_PATH && path !== `${LEARNINGS}TEMPLATE.md`;

// Run the compound step and keep at most one learning. Anything else it touched is put back.
export const compound = async (ctx: Ctx): Promise<string | null> => {
  const { state, config } = ctx;
  if (config.learn === "off" || !existsSync(join(state.repo, LEARNINGS))) return null;
  const evidence = struggles(state);
  if (!evidence) return null;
  const [{ result }] = await runStage(ctx, "compound", compoundBody(ctx, evidence));
  const changed = await changedPaths(state.repo);
  const learnings = changed.filter((c) => isLearning(c.path));
  const keep = learnings.length === 1 ? learnings[0].path : null;
  for (const c of changed) {
    if (c.path === keep) continue;
    if (c.untracked) rmSync(join(state.repo, c.path), { force: true });
    else await git(state.repo, "checkout", "HEAD", "--", c.path);
  }
  if (learnings.length > 1) ctx.log(`  compound wrote ${learnings.length} learnings; keeping none (want at most one)`);
  else if (changed.length > learnings.length) ctx.log(`  compound touched files outside ${LEARNINGS}; reverted them`);
  if (!keep) ctx.log(`  compound: no learning (${result.summary ?? result.action})`);
  return keep;
};

export type RecordOutcome = "recorded" | "skipped";

// Called once, at the first green. The push restarts CI, so finish waits for green again.
export const recordRun = async (ctx: Ctx): Promise<RecordOutcome> => {
  const { state } = ctx;
  if (!state.ip || !state.branch || !existsSync(join(state.repo, JOURNAL_DIR))) return "skipped";
  if ((await currentBranch(state.repo)) !== state.branch || (await anyChanges(state.repo))) {
    ctx.log(`  journal: skipped (not on a clean ${state.branch})`);
    return "skipped";
  }
  const learning = await compound(ctx);
  const decisions = promoteDecisions(state.repo, state.ip);
  const path = journalPath(state);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderJournal(state, learning, decisions, ctx.config.phi));
  const extras = [learning ? "a learning" : "", decisions.length ? `${decisions.length} decision${decisions.length > 1 ? "s" : ""}` : ""].filter(Boolean);
  const message = `Add run journal${extras.length ? ` with ${extras.join(" and ")}` : ""} for ${state.slug}`;
  await commitAll(state.repo, message, false);
  const push = await sh(state.repo, ["git", "push", "origin", state.branch]);
  if (push.code !== 0) {
    await git(state.repo, "reset", "--mixed", "HEAD~1");
    ctx.log(`  journal: push failed, left ${relative(state.repo, path)} uncommitted: ${push.err}`);
    return "skipped";
  }
  ctx.log(`  journal: ${relative(state.repo, path)}${learning ? `, learning: ${learning}` : ""}`);
  return "recorded";
};
