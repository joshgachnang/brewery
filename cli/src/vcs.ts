// git and GitHub. CI is an interface so the finish loop can be tested without GitHub.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ShResult {
  code: number;
  out: string;
  err: string;
}

export const sh = async (cwd: string, argv: string[], timeoutMs?: number): Promise<ShResult> => {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: out.trim(), err: err.trim() };
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

export interface PrSnapshot {
  sha: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeState: string;
  checks: Check[];
}

export interface Ci {
  prForBranch: (cwd: string) => Promise<number | null>;
  prUrl: (cwd: string, pr: number) => Promise<string>;
  snapshot: (cwd: string, pr: number) => Promise<PrSnapshot>;
  waitForChecks: (cwd: string, pr: number, timeoutMin: number) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const githubCi: Ci = {
  prForBranch: async (cwd) => {
    const res = await sh(cwd, ["gh", "pr", "view", "--json", "number", "-q", ".number"]);
    return res.code === 0 && res.out ? Number(res.out) : null;
  },
  prUrl: async (cwd, pr) => {
    const res = await sh(cwd, ["gh", "pr", "view", String(pr), "--json", "url", "-q", ".url"]);
    if (res.code !== 0 || !res.out) throw new Error(`gh pr view ${pr}: ${res.err || "missing URL"}`);
    return res.out;
  },
  snapshot: async (cwd, pr) => {
    let view: { headRefOid: string; mergeable: PrSnapshot["mergeable"]; mergeStateStatus: string } | null = null;
    // GitHub computes mergeability lazily; UNKNOWN usually settles within seconds.
    for (let i = 0; i < 6; i++) {
      const res = await sh(cwd, ["gh", "pr", "view", String(pr), "--json", "headRefOid,mergeable,mergeStateStatus"]);
      if (res.code !== 0) throw new Error(`gh pr view ${pr}: ${res.err}`);
      view = JSON.parse(res.out);
      if (view?.mergeable !== "UNKNOWN") break;
      await sleep(10_000);
    }
    const checks = await sh(cwd, ["gh", "pr", "checks", String(pr), "--json", "name,bucket,link"]);
    // exit 8 = checks pending, 1 with "no checks reported" = none yet; both still print JSON or nothing
    const list = checks.out.startsWith("[") ? (JSON.parse(checks.out) as Check[]) : [];
    return {
      sha: view?.headRefOid ?? "",
      mergeable: view?.mergeable ?? "UNKNOWN",
      mergeState: view?.mergeStateStatus ?? "",
      checks: list,
    };
  },
  waitForChecks: async (cwd, pr, timeoutMin) => {
    const deadline = Date.now() + timeoutMin * 60_000;
    // Checks can take a few minutes to register after a push; give them five.
    const graceEnd = Math.min(Date.now() + 5 * 60_000, deadline);
    let registered = false;
    while (!registered && Date.now() < graceEnd) {
      const probe = await sh(cwd, ["gh", "pr", "checks", String(pr), "--json", "bucket"]);
      registered = probe.out.startsWith("[") && probe.out !== "[]";
      if (!registered) await sleep(30_000);
    }
    if (!registered) return;
    const remaining = Math.max(deadline - Date.now(), 1_000);
    await sh(cwd, ["gh", "pr", "checks", String(pr), "--watch", "--interval", "30"], remaining);
  },
};
