// git, and the Ci interface finish, barrel, and approve use (implemented on both forges by
// forgeCi in forge/ci.ts), so the finish loop can be tested without a forge.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isResourceError, reportPressure, retryDelaysMs } from "./pressure.ts";

export interface ShResult {
  code: number;
  out: string;
  err: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const shOnce = async (cwd: string, argv: string[], timeoutMs?: number): Promise<ShResult> => {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: out.trim(), err: err.trim() };
};

// A sandbox briefly out of threads fails a spawn, or the child itself ("Resource temporarily
// unavailable"). Waiting a moment fixes it; each failure also lowers the run's parallel limit.
export const sh = async (cwd: string, argv: string[], timeoutMs?: number): Promise<ShResult> => {
  for (let attempt = 0; ; attempt++) {
    let res: ShResult | undefined;
    let failure: unknown;
    try {
      res = await shOnce(cwd, argv, timeoutMs);
      if (res.code === 0 || !isResourceError(res.err)) return res;
      failure = new Error(res.err);
    } catch (error) {
      if (!isResourceError(error)) throw error;
      failure = error;
    }
    reportPressure();
    const delay = retryDelaysMs[attempt];
    if (delay === undefined) {
      if (res) return res;
      throw failure;
    }
    await sleep(delay);
  }
};

export const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const res = await sh(cwd, ["git", ...args]);
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.err || res.out}`);
  return res.out;
};

export const repoRoot = async (cwd: string): Promise<string> => git(cwd, "rev-parse", "--show-toplevel");
export const currentBranch = async (cwd: string): Promise<string> => git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
export const headSha = async (cwd: string): Promise<string> => git(cwd, "rev-parse", "HEAD");

export const defaultBase = async (cwd: string): Promise<string> => {
  const res = await sh(cwd, ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (res.code === 0 && res.out) return res.out.replace(/^origin\//, "");
  for (const name of ["master", "main"]) {
    if ((await sh(cwd, ["git", "rev-parse", "--verify", "--quiet", name])).code === 0) return name;
  }
  return "master";
};

// Tracked files with changes. Untracked files (a fresh IP) do not count.
export const trackedChanges = async (cwd: string): Promise<string[]> =>
  (await git(cwd, "status", "--porcelain", "--untracked-files=no")).split("\n").filter(Boolean);

export const anyChanges = async (cwd: string): Promise<boolean> => (await git(cwd, "status", "--porcelain")).length > 0;

// Keep brewery's state out of commits without touching the repo's .gitignore.
export const ensureExcluded = async (cwd: string): Promise<void> => {
  const probe = await sh(cwd, ["git", "check-ignore", "-q", ".terreno/brewery/x"]);
  if (probe.code === 0) return;
  const gitDir = await git(cwd, "rev-parse", "--git-common-dir");
  const info = resolve(cwd, gitDir, "info");
  const exclude = join(info, "exclude");
  mkdirSync(info, { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  appendFileSync(exclude, `${current.endsWith("\n") || !current ? "" : "\n"}.terreno/\n`);
  if ((await sh(cwd, ["git", "check-ignore", "-q", ".terreno/brewery/x"])).code !== 0) {
    throw new Error("brewery: cannot exclude private run artifacts from Git");
  }
};

export const commitAll = async (cwd: string, message: string, amend: boolean): Promise<string> => {
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "--no-verify", ...(amend ? ["--amend"] : []), "-m", message);
  return headSha(cwd);
};

export const addWorktree = async (cwd: string, dir: string, branch?: string, head = "HEAD"): Promise<void> => {
  await git(cwd, "worktree", "add", ...(branch ? ["-b", branch] : ["--detach"]), dir, head);
};

export const removeWorktreeStrict = async (cwd: string, dir: string): Promise<void> => {
  await git(cwd, "worktree", "remove", "--force", dir);
};

// Cleanup on failure paths must never replace the caller's original outcome.
export const removeWorktree = async (cwd: string, dir: string, log: (line: string) => void = console.warn): Promise<boolean> => {
  try {
    await removeWorktreeStrict(cwd, dir);
    return true;
  } catch (error) {
    log(`  cleanup failed for ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
};

export interface Check {
  name: string;
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
  link?: string;
}

// An unresolved review thread started by a bot (Bugbot, CodeQL, Copilot, ...) that nobody has answered.
export interface BotThread {
  id: string;
  author: string;
  path?: string;
  line?: number;
  body: string;
}

export interface PrSnapshot {
  sha: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeState: string;
  checks: Check[];
  botThreads?: BotThread[];
}

interface ThreadNode {
  id: string;
  isResolved: boolean;
  comments: { nodes: { author: { __typename: string; login: string } | null; path?: string; line?: number | null; body: string }[] };
}

const isBot = (author: { __typename: string; login: string } | null): boolean =>
  !!author && (author.__typename === "Bot" || author.login.endsWith("[bot]"));

// A bot thread counts as answered once anyone other than a bot has replied in it.
export const unansweredBotThreads = (nodes: ThreadNode[]): BotThread[] =>
  nodes
    .filter((t) => !t.isResolved && isBot(t.comments.nodes[0]?.author ?? null))
    .filter((t) => t.comments.nodes.slice(1).every((c) => isBot(c.author)))
    .map((t) => {
      const first = t.comments.nodes[0];
      return { id: t.id, author: first.author?.login ?? "", path: first.path, line: first.line ?? undefined, body: first.body.slice(0, 300) };
    });

export interface PrReview {
  // The review id forge reports: GitHub's GraphQL node id (PRR_...), what a dismissal takes.
  id: string;
  author: string;
  state: string;
  body: string;
  isBot: boolean;
  commit?: string;
}

export interface PrView {
  number: number;
  title: string;
  body: string;
  author: string;
  authorIsBot: boolean;
  isDraft: boolean;
  labels: string[];
  base: string;
  headSha: string;
  reviews: PrReview[];
  checks: Check[];
  botThreads: BotThread[];
}

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface Ci {
  prForBranch: (cwd: string) => Promise<number | null>;
  // `brewery approve` reads: the PR with its reviews, checks, and unanswered bot threads;
  // the changed files with stats; the unified diff.
  prView: (cwd: string, pr: number) => Promise<PrView>;
  prFiles: (cwd: string, pr: number) => Promise<ChangedFile[]>;
  prDiff: (cwd: string, pr: number) => Promise<string>;
  prUrl: (cwd: string, pr: number) => Promise<string>;
  snapshot: (cwd: string, pr: number) => Promise<PrSnapshot>;
  waitForChecks: (cwd: string, pr: number, timeoutMin: number) => Promise<void>;
  // The failed steps' log for a check, or "" when it isn't a GitHub or Forgejo Actions job.
  failedLog: (cwd: string, link: string) => Promise<string>;
}

