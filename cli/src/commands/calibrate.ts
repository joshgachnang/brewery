// brewery calibrate <owner/name>: read what humans said in PR reviews since the last pass
// (plus any notes the human pastes in), and let the calibrate skill turn the recurring
// ones into approval rubric rules and path rules. One PR per pass, like cellar.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import type { Forge, ReviewNote, ReviewedPr } from "../forge.ts";
import { ping } from "../human.ts";
import { changedPaths, isLearning } from "../learn.ts";
import { calibrateBody, MAX_RUBRIC_RULES } from "../prompts.ts";
import { scrub } from "../scrub.ts";
import { newState, runDir, saveState } from "../state.ts";
import { runStage } from "../step.ts";
import { commitAll, defaultBase, ensureExcluded, git, removeWorktree, sh } from "../vcs.ts";
import { resolveCheckout, stateDir } from "./cellar.ts";

const FIRST_LOOKBACK_DAYS = 30;
const HUNK_CHARS = 600;
const BODY_CHARS = 1500;
const APPROVER_MARKER = "terreno-approve:";

export interface CalibrateOptions {
  since?: string;
  // GitHub logins whose words count. Empty means every human.
  reviewers?: string[];
  // Free-form notes the human pasted: review comments from anywhere, or plain opinions.
  notes?: string;
  dryRun?: boolean;
  now?: Date;
  log?: (line: string) => void;
}

export interface CalibrateOutcome {
  status: "pr" | "nothing" | "no-changes" | "too-many" | "disallowed" | "dry-run" | "off";
  url?: string;
  evidence?: string;
  detail?: string;
}

const stampPath = (name: string): string => join(stateDir(), `calibrate__${name.replace("/", "__")}.json`);

const readStamp = (name: string): string | undefined =>
  existsSync(stampPath(name)) ? (JSON.parse(readFileSync(stampPath(name), "utf8")) as { since: string }).since : undefined;

const finishPass = (name: string, now: Date, outcome: CalibrateOutcome, stamp: boolean): CalibrateOutcome => {
  mkdirSync(stateDir(), { recursive: true });
  if (stamp) writeFileSync(stampPath(name), `${JSON.stringify({ since: now.toISOString() })}\n`);
  appendFileSync(join(stateDir(), "calibrate.log"), `${now.toISOString()}\t${name}\t${outcome.status}\t${outcome.url ?? ""}\n`);
  return outcome;
};

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

// A verdict without words (APPROVED, CHANGES_REQUESTED) still counts; a bare COMMENTED does not.
const saidSomething = (note: ReviewNote): boolean => note.body.trim().length > 0 || (note.kind === "review" && !!note.state && note.state !== "COMMENTED");

const isHuman = (note: ReviewNote, reviewers: string[]): boolean =>
  !note.isBot && saidSomething(note) && (!reviewers.length || reviewers.includes(note.author));

// The approval agent's own first line on the PR, when it reviewed it: what the robot said
// next to what the human said is the calibration signal.
const agentLine = (pr: ReviewedPr): string | null => {
  const mine = pr.notes.filter((n) => n.kind === "review" && n.isBot && n.body.includes(APPROVER_MARKER)).at(-1);
  if (!mine) return null;
  return mine.body.split("\n").find((l) => l.startsWith("**")) ?? null;
};

export interface Selected {
  pr: ReviewedPr;
  notes: ReviewNote[];
}

// PRs with at least one human note that counts, newest first.
export const selectPrs = (prs: ReviewedPr[], reviewers: string[]): Selected[] =>
  prs
    .map((pr) => ({ pr, notes: pr.notes.filter((n) => isHuman(n, reviewers)) }))
    .filter((s) => s.notes.length > 0);

export const renderEvidence = (name: string, since: string, selected: Selected[], notes: string | undefined): string => {
  const out: string[] = [`# What humans said on ${name} pull requests since ${since}`, ""];
  if (!selected.length) out.push("No human review comments in the window.", "");
  for (const { pr, notes: said } of selected) {
    out.push(`## #${pr.number} ${pr.title} (${pr.state}, by @${pr.author}) ${pr.url}`, "");
    const verdicts = said.filter((n) => n.kind === "review" && n.state && n.state !== "COMMENTED").map((n) => `@${n.author} ${n.state}`);
    if (verdicts.length) out.push(`Human verdicts: ${[...new Set(verdicts)].join(", ")}`);
    const robot = agentLine(pr);
    if (robot) out.push(`Approval agent said: ${robot}`);
    if (verdicts.length || robot) out.push("");
    for (const n of said) {
      if (!n.body.trim()) continue;
      const who = `@${n.author}${n.author === pr.author ? " (author)" : ""}`;
      const where = n.kind === "inline" ? ` on \`${n.path}${n.line ? `:${n.line}` : ""}\`` : n.kind === "review" ? ` (review${n.state ? ` ${n.state}` : ""})` : "";
      out.push(`- ${who}${where}: ${clip(scrub(n.body).replace(/\r?\n/g, "\n  "), BODY_CHARS)}`);
      if (n.hunk) out.push("  ~~~", `  ${clip(scrub(n.hunk), HUNK_CHARS).replace(/\n/g, "\n  ")}`, "  ~~~");
    }
    out.push("");
  }
  if (notes?.trim()) out.push("## Notes from the human", "", "These were pasted in by hand; treat them as review comments with the human's weight.", "", scrub(notes.trim()), "");
  return out.join("\n");
};

const bullets = (text: string): string[] => text.split("\n").filter((l) => /^\s*[-*] /.test(l));

// New rubric bullets, plus every changed file that is not the rubric, .brewery.json, or a learning.
export const countChanges = (
  rubricBefore: string,
  rubricAfter: string,
  changed: string[],
  rubricPath: string,
): { rules: number; disallowed: string[] } => {
  const before = bullets(rubricBefore);
  const rules = bullets(rubricAfter).filter((l) => !before.includes(l)).length;
  const disallowed = changed.filter((p) => p !== rubricPath && p !== ".brewery.json" && !isLearning(p));
  return { rules, disallowed };
};

const prBody = (summary: string, changes: string[], proposals: string, since: string, counts: string): string =>
  [
    summary || "Rubric changes from recent human reviews.",
    "",
    "## Changes",
    "",
    ...(changes.length ? changes.map((c) => `- ${c}`) : ["- See the diff."]),
    ...(proposals ? ["", "## Proposed lines for brewery's default rubric", "", proposals] : []),
    "",
    `Evidence since ${since}: ${counts}. Opened by \`brewery calibrate\`.`,
  ].join("\n");

export const calibrate = async (name: string, forge: Forge, opts: CalibrateOptions = {}): Promise<CalibrateOutcome> => {
  const log = opts.log ?? ((line: string) => console.log(line));
  if (!/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error(`brewery calibrate: want owner/name, got "${name}"`);
  const now = opts.now ?? new Date();
  let repo = await resolveCheckout(name);
  if (!repo) {
    repo = join(mkdtempSync(join(tmpdir(), "brewery-calibrate-")), name.split("/")[1]);
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
  const rubricPath = config.approve.rubric;

  const selected = selectPrs(await forge.reviewedPrs(name, since), opts.reviewers ?? []);
  const noteCount = selected.reduce((sum, s) => sum + s.notes.length, 0);
  const counts = `${selected.length} PRs with ${noteCount} human comments${opts.notes?.trim() ? ", plus pasted notes" : ""}`;
  if (!selected.length && !opts.notes?.trim()) {
    log(`${name}: no human review comments since ${since}`);
    return finishPass(name, now, { status: "nothing" }, !opts.dryRun);
  }
  const evidence = renderEvidence(name, since, selected, opts.notes);
  if (opts.dryRun) {
    log(evidence);
    return { status: "dry-run", evidence };
  }

  await ensureExcluded(repo);
  const slug = `calibrate-${now.toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1-")}`;
  const state = newState({ slug, repo, ip: "", base, phase: "build" });
  saveState(state);
  writeFileSync(join(runDir(repo, slug), "evidence.md"), evidence);
  const tree = join(mkdtempSync(join(tmpdir(), "brewery-calibrate-tree-")), "tree");
  await git(repo, "worktree", "add", "-q", "-b", slug, tree, ref);
  const cleanup = async (): Promise<void> => {
    await removeWorktree(repo, tree);
    await sh(repo, ["git", "branch", "-D", slug]);
  };
  try {
    const rubricFile = join(tree, rubricPath);
    const before = existsSync(rubricFile) ? readFileSync(rubricFile, "utf8") : "";
    const ctx = { state, config, log };
    const [{ result }] = await runStage(ctx, "calibrate", calibrateBody(ctx, name, since, rubricPath, evidence), { cwd: tree });
    const changed = (await changedPaths(tree)).map((c) => c.path);
    state.phase = "done";
    saveState(state);
    if (!changed.length) {
      log(`${name}: no changes (${result.summary ?? result.action})`);
      return finishPass(name, now, { status: "no-changes" }, true);
    }
    const after = existsSync(rubricFile) ? readFileSync(rubricFile, "utf8") : "";
    const { rules, disallowed } = countChanges(before, after, changed, rubricPath);
    if (disallowed.length) {
      log(`${name}: the agent changed files outside the rubric, .brewery.json, and docs/learnings: ${disallowed.join(", ")}; no PR. Evidence: ${join(runDir(repo, slug), "evidence.md")}`);
      return finishPass(name, now, { status: "disallowed", detail: disallowed.join(", ") }, false);
    }
    if (rules > MAX_RUBRIC_RULES) {
      log(`${name}: ${rules} new rubric lines, over the limit of ${MAX_RUBRIC_RULES}; no PR. Evidence: ${join(runDir(repo, slug), "evidence.md")}`);
      await ping(config.notify.ntfyUrl, `brewery calibrate: ${name} proposed too many rubric changes; see calibrate.log`);
      return finishPass(name, now, { status: "too-many" }, false);
    }
    const title = `Calibrate the approval rubric from reviews ${since.slice(0, 10)} to ${now.toISOString().slice(0, 10)}`;
    await commitAll(tree, title, false);
    await git(tree, "push", "-q", "origin", slug);
    const extra = result as unknown as { changes?: string[]; proposals?: string };
    const url = await forge.createPr(tree, { name, base, head: slug, title, body: prBody(result.summary ?? "", extra.changes ?? [], extra.proposals ?? "", since, counts) });
    log(`${name}: opened ${url}`);
    if (extra.proposals?.trim()) log(`\nProposed lines for brewery's default rubric (cli/templates/approval-rubric.md):\n${extra.proposals.trim()}`);
    await ping(config.notify.ntfyUrl, `brewery calibrate: ${name} PR ready`);
    return finishPass(name, now, { status: "pr", url }, true);
  } finally {
    await cleanup();
  }
};
