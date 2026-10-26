// `brewery board`: one repo's plans, runs, open PRs, and recent merges on one screen.
// The IPs in the plan directories are the board; run state under .terreno/brewery says what
// is moving, and the forge (or git, offline) says what shipped.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isApproved, parseTasks, readStatus, title, type IpTask } from "./ip.ts";
import type { RunState } from "./state.ts";
import { sh } from "./vcs.ts";

export interface PlanFile {
  // Relative to the repo root.
  path: string;
  text: string;
}

export interface OpenPr {
  number: number;
  title: string;
  branch: string;
  isDraft: boolean;
}

export interface Merge {
  // PR number when the forge answered, otherwise the commit.
  ref: string;
  title: string;
  at: string;
}

export interface BoardInput {
  repo: string;
  plans: PlanFile[];
  runs: RunState[];
  openPrs: OpenPr[];
  merges: Merge[];
}

export interface BoardTask {
  plan: string;
  id: string;
  title: string;
  // Unlanded dependencies, for blocked tasks.
  waitingOn?: string[];
}

export interface BoardItem {
  plan: string;
  title: string;
  detail: string;
}

export interface Board {
  inProgress: BoardItem[];
  blocked: BoardItem[];
  next: BoardTask[];
  waitingTasks: BoardTask[];
  merges: Merge[];
  plans: { open: number; done: number };
}

const firstLine = (text: string): string => text.split("\n").find((l) => l.trim())?.trim().slice(0, 140) ?? "";

const runFor = (input: BoardInput, plan: PlanFile): RunState | undefined =>
  input.runs.find((run) => run.ip && relative(input.repo, run.ip) === plan.path && run.phase !== "done");

export const buildBoard = (input: BoardInput): Board => {
  const board: Board = { inProgress: [], blocked: [], next: [], waitingTasks: [], merges: input.merges, plans: { open: 0, done: 0 } };
  const claimedBranches = new Set<string>();
  const claimedPrs = new Set<number>();

  for (const plan of [...input.plans].sort((a, b) => a.path.localeCompare(b.path))) {
    const tasks = parseTasks(plan.text);
    const status = readStatus(plan.text);
    const run = runFor(input, plan);
    if (run?.branch) claimedBranches.add(run.branch);
    if (run?.pr) claimedPrs.add(run.pr);
    // The main tree's IP lags the feature branch during a run, so run state counts as landed too.
    const landed = new Set(tasks.filter((t) => t.done).map((t) => t.id));
    const running = new Set<string>();
    for (const [id, t] of Object.entries(run?.tasks ?? {})) {
      if (t.status === "passed" || t.status === "skipped") landed.add(id);
      if (t.status === "running") running.add(id);
    }
    const open = tasks.filter((t) => !landed.has(t.id));
    if (tasks.length && !open.length && !run) {
      board.plans.done++;
      continue;
    }
    if (!tasks.length && !status) continue;
    board.plans.open++;
    const name = title(plan.text);
    const progress = tasks.length ? `${tasks.length - open.length}/${tasks.length} tasks` : "no tasks";

    if (run?.waiting) {
      board.blocked.push({ plan: plan.path, title: name, detail: `waiting on you (${run.waiting.kind}${run.waiting.task ? ` ${run.waiting.task}` : ""}): ${firstLine(run.waiting.message)} — brewery answer ${run.slug} "<reply>"` });
      continue;
    }
    if (status !== null && !isApproved(plan.text)) {
      board.blocked.push({ plan: plan.path, title: name, detail: `not approved (Status: ${status || "empty"}), ${progress}` });
      continue;
    }
    if (run && run.phase !== "approved") {
      const bits = [run.phase, progress];
      if (running.size) bits.push(`running ${[...running].join(", ")}`);
      if (run.pr) bits.push(`PR #${run.pr}`);
      board.inProgress.push({ plan: plan.path, title: name, detail: bits.join(", ") });
    }
    const queued = (t: IpTask): boolean => !running.has(t.id);
    for (const task of open.filter(queued)) {
      const missing = task.deps.filter((d) => !landed.has(d));
      if (missing.length) board.waitingTasks.push({ plan: plan.path, id: task.id, title: task.title, waitingOn: missing });
      else board.next.push({ plan: plan.path, id: task.id, title: task.title });
    }
  }

  // Runs without an IP on disk (finish on a bare PR) and PRs no run owns.
  for (const run of input.runs) {
    if (run.phase === "done" || (run.ip && input.plans.some((p) => relative(input.repo, run.ip) === p.path))) continue;
    if (run.slug.startsWith("approve-") || run.slug.startsWith("cut-")) continue;
    if (run.branch) claimedBranches.add(run.branch);
    if (run.pr) claimedPrs.add(run.pr);
    const item = { plan: "", title: run.slug, detail: `${run.phase}${run.pr ? `, PR #${run.pr}` : ""}` };
    if (run.waiting) board.blocked.push({ ...item, detail: `waiting on you (${run.waiting.kind}): ${firstLine(run.waiting.message)}` });
    else board.inProgress.push(item);
  }
  for (const pr of input.openPrs) {
    if (claimedPrs.has(pr.number) || claimedBranches.has(pr.branch)) continue;
    board.inProgress.push({ plan: "", title: `PR #${pr.number} ${pr.title}`, detail: `${pr.isDraft ? "draft, " : ""}${pr.branch}` });
  }
  return board;
};

const section = (heading: string, lines: string[], empty: string): string =>
  `${heading}\n${lines.length ? lines.map((l) => `  ${l}`).join("\n") : `  ${empty}`}`;

const where = (item: { plan: string }): string => (item.plan ? `  (${item.plan})` : "");

export const renderBoard = (board: Board): string => [
  section("In progress", board.inProgress.map((i) => `${i.title} — ${i.detail}${where(i)}`), "nothing running"),
  section("Blocked", [
    ...board.blocked.map((i) => `${i.title} — ${i.detail}${where(i)}`),
    ...board.waitingTasks.map((t) => `${t.id} ${t.title} — after ${t.waitingOn!.join(", ")}${where(t)}`),
  ], "nothing blocked"),
  section("Next up", board.next.map((t) => `${t.id} ${t.title}${where(t)}`), "no ready tasks"),
  section("Recent merges", board.merges.map((m) => `${m.at.slice(0, 10)}  ${m.ref.padEnd(8)} ${m.title}`), "none found"),
  `${board.plans.open} open plan${board.plans.open === 1 ? "" : "s"}, ${board.plans.done} done`,
].join("\n\n");

const readPlans = (repo: string, dirs: string[]): PlanFile[] => {
  const out: PlanFile[] = [];
  for (const dir of dirs) {
    const abs = join(repo, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs).filter((n) => n.endsWith(".md"))) {
      out.push({ path: join(dir, name), text: readFileSync(join(abs, name), "utf8") });
    }
  }
  return out;
};

const readRuns = (repo: string): RunState[] => {
  const dir = join(repo, ".terreno", "brewery");
  if (!existsSync(dir)) return [];
  const out: RunState[] = [];
  for (const slug of readdirSync(dir)) {
    const path = join(dir, slug, "state.json");
    if (!existsSync(path)) continue;
    try {
      out.push(JSON.parse(readFileSync(path, "utf8")) as RunState);
    } catch {
      // A half-written state file is a run mid-save; the next look will see it.
    }
  }
  return out;
};

const ghJson = async <T>(repo: string, argv: string[]): Promise<T | undefined> => {
  const res = await sh(repo, ["gh", ...argv], 20_000);
  if (res.code !== 0) return undefined;
  try {
    return JSON.parse(res.out || "[]") as T;
  } catch {
    return undefined;
  }
};

// Merged PRs from GitHub; offline or without gh, the base branch's first-parent history.
const readMerges = async (repo: string, base: string, limit: number): Promise<Merge[]> => {
  const prs = await ghJson<{ number: number; title: string; mergedAt: string }[]>(repo, [
    "pr", "list", "--state", "merged", "--limit", String(limit), "--json", "number,title,mergedAt",
  ]);
  if (prs) return prs.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt)).map((p) => ({ ref: `#${p.number}`, title: p.title, at: p.mergedAt }));
  for (const ref of [`origin/${base}`, base]) {
    const res = await sh(repo, ["git", "log", "--first-parent", `-${limit}`, "--format=%h%x09%cI%x09%s", ref]);
    if (res.code !== 0) continue;
    return res.out.split("\n").filter(Boolean).map((line) => {
      const [sha, at, subject] = line.split("\t");
      return { ref: sha, title: subject, at };
    });
  }
  return [];
};

export const gatherBoard = async (repo: string, opts: { base: string; planDirs: string[]; merges: number }): Promise<BoardInput> => {
  const [openPrs, merges] = await Promise.all([
    ghJson<{ number: number; title: string; headRefName: string; isDraft: boolean }[]>(repo, [
      "pr", "list", "--state", "open", "--limit", "50", "--json", "number,title,headRefName,isDraft",
    ]),
    readMerges(repo, opts.base, opts.merges),
  ]);
  return {
    repo,
    plans: readPlans(repo, opts.planDirs),
    runs: readRuns(repo),
    openPrs: (openPrs ?? []).map((p) => ({ number: p.number, title: p.title, branch: p.headRefName, isDraft: p.isDraft })),
    merges,
  };
};
