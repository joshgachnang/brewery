// The nightly learning pass for one repo: gather what happened since the last pass
// (brewery journals on the default branch, failed CI runs, merged PRs from any session),
// let the cellar skill turn it into learnings, rules, and checks, and open one PR.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { failureExcerpt } from "../ci.ts";
import { configuredRepos, loadConfig } from "../config.ts";
import { activeRules, RULES_PATH } from "../docs.ts";
import type { FailedRun, Forge, MergedPr } from "../forge.ts";
import { ping } from "../human.ts";
import { changedPaths, isLearning } from "../learn.ts";
import { cellarBody } from "../prompts.ts";
import { scrubTail } from "../scrub.ts";
import { newState, readIndex, runDir, saveState } from "../state.ts";
import { runStage } from "../step.ts";
import { commitAll, defaultBase, ensureExcluded, git, removeWorktree, sh } from "../vcs.ts";

export const MAX_CHANGES = 3;
const LOGS = 10;
const FIRST_LOOKBACK_DAYS = 7;

export interface CellarOptions {
  since?: string;
  dryRun?: boolean;
  now?: Date;
  log?: (line: string) => void;
}

export interface CellarOutcome {
  status: "pr" | "nothing" | "no-changes" | "too-many" | "dry-run" | "off";
  url?: string;
  evidence?: string;
}

export const stateDir = (): string => process.env.BREWERY_CELLAR_DIR ?? join(homedir(), ".local", "state", "brewery", "cellar");
const stampPath = (name: string): string => join(stateDir(), `${name.replace("/", "__")}.json`);

const readStamp = (name: string): string | undefined =>
  existsSync(stampPath(name)) ? (JSON.parse(readFileSync(stampPath(name), "utf8")) as { since: string }).since : undefined;

const finishPass = (name: string, now: Date, outcome: CellarOutcome, stamp: boolean): CellarOutcome => {
  mkdirSync(stateDir(), { recursive: true });
  if (stamp) writeFileSync(stampPath(name), `${JSON.stringify({ since: now.toISOString() })}\n`);
  appendFileSync(join(stateDir(), "cellar.log"), `${now.toISOString()}\t${name}\t${outcome.status}\t${outcome.url ?? ""}\n`);
  return outcome;
};

const sameRepo = (url: string, name: string): boolean =>
  new RegExp(`[:/]${name.replace(/[.]/g, "\\.")}(\\.git)?/?$`, "i").test(url.trim());

// A local checkout of owner/name: the user config's `repos`, else any repo brewery has run in.
export const resolveCheckout = async (name: string): Promise<string | null> => {
  const configured = configuredRepos()[name];
  if (configured && existsSync(configured)) return configured;
  for (const repo of new Set(Object.values(readIndex()))) {
    if (!existsSync(repo)) continue;
    const url = await sh(repo, ["git", "remote", "get-url", "origin"]);
    if (url.code === 0 && sameRepo(url.out, name)) return repo;
  }
  return null;
};

const lines = (text: string): string[] => text.split("\n").filter(Boolean);

export const renderEvidence = (
  name: string,
  since: string,
  journals: string[],
  failed: FailedRun[],
  logs: Map<number, string>,
  merged: MergedPr[],
): string => {
  const out: string[] = [`# Evidence for ${name} since ${since}`, ""];
  out.push("## brewery journals merged or updated on the default branch", "");
  out.push(...(journals.length ? journals.map((j) => `- ${j}`) : ["None."]), "");
  out.push("## Failed CI runs", "");
  if (!failed.length) out.push("None.", "");
  const byWorkflow = new Map<string, FailedRun[]>();
  for (const run of failed) byWorkflow.set(run.workflow, [...(byWorkflow.get(run.workflow) ?? []), run]);
  for (const [workflow, runs] of byWorkflow) {
    out.push(`### ${workflow}: ${runs.length} failed run${runs.length > 1 ? "s" : ""}`, "");
    for (const run of runs) out.push(`- ${run.createdAt.slice(0, 16)} ${run.branch} ${run.sha.slice(0, 8)} ${run.url}`);
    out.push("");
    for (const run of runs) {
      const log = logs.get(run.id);
      if (log) out.push(`Failed-step log, run ${run.id} (${run.branch}):`, "~~~", log, "~~~", "");
    }
  }
  out.push("## Merged PRs", "");
  out.push(...(merged.length ? merged.map((p) => `- #${p.number} ${p.title} (${p.branch}, @${p.author}, ${p.mergedAt.slice(0, 10)}) ${p.url}`) : ["None."]), "");
  return out.join("\n");
};

// Rule lines added to RULES.md's Active section, plus every changed file that is not a learning.
export const countChanges = (before: string[], after: string[], changed: string[]): number =>
  after.filter((rule) => !before.includes(rule)).length + changed.filter((p) => !isLearning(p) && p !== RULES_PATH).length;

const prBody = (summary: string, changes: string[], proposals: string, since: string, counts: string): string =>
  [
    summary || "Learnings from recent runs.",
    "",
    "## Changes",
    "",
    ...(changes.length ? changes.map((c) => `- ${c}`) : ["- See the diff."]),
    ...(proposals ? ["", "## Proposed brewery skill changes", "", proposals] : []),
    "",
    `Evidence since ${since}: ${counts}. Opened by \`brewery cellar\`.`,
  ].join("\n");

export const cellar = async (name: string, forge: Forge, opts: CellarOptions = {}): Promise<CellarOutcome> => {
  const log = opts.log ?? ((line: string) => console.log(line));
  if (!/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error(`brewery cellar: want owner/name, got "${name}"`);
  const now = opts.now ?? new Date();
  let repo = await resolveCheckout(name);
  if (!repo) {
    repo = join(mkdtempSync(join(tmpdir(), "brewery-cellar-")), name.split("/")[1]);
    log(`no local checkout of ${name}; cloning to ${repo}`);
    await forge.clone(name, repo);
  }
  const config = loadConfig(repo);
  if (config.learn === "off") {
    log(`${name}: learn is off in .brewery.json`);
    return { status: "off" };
  }
  const since = opts.since ?? readStamp(name) ?? new Date(now.getTime() - FIRST_LOOKBACK_DAYS * 86_400_000).toISOString();
  await git(repo, "fetch", "-q", "origin");
  const base = await defaultBase(repo);
  const ref = `origin/${base}`;

  const journals = [...new Set(lines(await git(repo, "log", ref, `--since=${since}`, "--name-only", "--format=", "--diff-filter=AM", "--", "docs/journal")))].filter((p) => p.endsWith(".md"));
  const failed = await forge.failedRuns(name, since);
  const merged = await forge.mergedPrs(name, since);
  const counts = `${journals.length} journals, ${failed.length} failed CI runs, ${merged.length} merged PRs`;
  if (!journals.length && !failed.length && !merged.length) {
    log(`${name}: nothing new since ${since}`);
    return finishPass(name, now, { status: "nothing" }, !opts.dryRun);
  }

  // One log per workflow and branch, newest first: enough to see the signature.
  const logs = new Map<number, string>();
  const seen = new Set<string>();
  for (const run of [...failed].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const key = `${run.workflow}|${run.branch}`;
    if (seen.has(key) || logs.size >= LOGS) continue;
    seen.add(key);
    const text = scrubTail(failureExcerpt(await forge.runLog(name, run.id)), 3000);
    if (text) logs.set(run.id, text);
  }
  const evidence = renderEvidence(name, since, journals, failed, logs, merged);
  if (opts.dryRun) {
    log(evidence);
    return { status: "dry-run", evidence };
  }

  await ensureExcluded(repo);
  const slug = `cellar-${now.toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1-")}`;
  const state = newState({ slug, repo, ip: "", base, phase: "build" });
  saveState(state);
  writeFileSync(join(runDir(repo, slug), "evidence.md"), evidence);
  const tree = join(mkdtempSync(join(tmpdir(), "brewery-cellar-tree-")), "tree");
  await git(repo, "worktree", "add", "-q", "-b", slug, tree, ref);
  const cleanup = async (): Promise<void> => {
    await removeWorktree(repo, tree);
    await sh(repo, ["git", "branch", "-D", slug]);
  };
  try {
    const before = activeRules(tree);
    const ctx = { state, config, log };
    const [{ result }] = await runStage(ctx, "cellar", cellarBody(ctx, name, since, evidence), { cwd: tree });
    const changed = (await changedPaths(tree)).map((c) => c.path);
    state.phase = "done";
    saveState(state);
    if (!changed.length) {
      log(`${name}: no changes (${result.summary ?? result.action})`);
      return finishPass(name, now, { status: "no-changes" }, true);
    }
    const n = countChanges(before, activeRules(tree), changed);
    if (n > MAX_CHANGES) {
      log(`${name}: ${n} rule or check changes, over the limit of ${MAX_CHANGES}; no PR. Evidence: ${join(runDir(repo, slug), "evidence.md")}`);
      await ping(config.notify.ntfyUrl, `brewery cellar: ${name} proposed too many changes; see cellar.log`);
      return finishPass(name, now, { status: "too-many" }, false);
    }
    const title = `Record learnings from ${since.slice(0, 10)} to ${now.toISOString().slice(0, 10)}`;
    await commitAll(tree, title, false);
    await git(tree, "push", "-q", "origin", slug);
    const extra = result as unknown as { changes?: string[]; proposals?: string };
    const proposals = config.learn === "shared" ? (extra.proposals ?? "") : "";
    const url = await forge.createPr(tree, { name, base, head: slug, title, body: prBody(result.summary ?? "", extra.changes ?? [], proposals, since, counts) });
    log(`${name}: opened ${url}`);
    await ping(config.notify.ntfyUrl, `brewery cellar: ${name} PR ready`);
    return finishPass(name, now, { status: "pr", url }, true);
  } finally {
    await cleanup();
  }
};
