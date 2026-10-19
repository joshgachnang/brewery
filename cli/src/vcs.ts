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

const BOT_THREADS_QUERY = `query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes { id isResolved comments(first: 50) { nodes { author { __typename login } path line body } } }
      }
    }
  }
}`;

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
  // GraphQL node id from `gh pr view --json reviews` (PRR_...), what a dismissal takes.
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
  // The failed steps' log for a check, or "" when it isn't a GitHub Actions job.
  failedLog: (cwd: string, link: string) => Promise<string>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const botThreadsFor = async (cwd: string, pr: number): Promise<BotThread[]> => {
  const threads = await sh(cwd, [
    "gh", "api", "graphql", "-f", `query=${BOT_THREADS_QUERY}`, "-F", "owner={owner}", "-F", "repo={repo}", "-F", `pr=${pr}`,
    "--jq", ".data.repository.pullRequest.reviewThreads.nodes",
  ]);
  if (threads.code !== 0) throw new Error(`gh api graphql reviewThreads ${pr}: ${threads.err}`);
  return threads.out.startsWith("[") ? unansweredBotThreads(JSON.parse(threads.out) as ThreadNode[]) : [];
};

const checksFor = async (cwd: string, pr: number): Promise<Check[]> => {
  const checks = await sh(cwd, ["gh", "pr", "checks", String(pr), "--json", "name,bucket,link"]);
  // exit 8 = checks pending, 1 with "no checks reported" = none yet; both still print JSON or nothing
  return checks.out.startsWith("[") ? (JSON.parse(checks.out) as Check[]) : [];
};

export const githubCi: Ci = {
  prForBranch: async (cwd) => {
    const res = await sh(cwd, ["gh", "pr", "view", "--json", "number", "-q", ".number"]);
    return res.code === 0 && res.out ? Number(res.out) : null;
  },
  prView: async (cwd, pr) => {
    const res = await sh(cwd, [
      "gh", "pr", "view", String(pr), "--json",
      "number,title,body,author,isDraft,labels,baseRefName,headRefOid,reviews",
    ]);
    if (res.code !== 0) throw new Error(`gh pr view ${pr}: ${res.err}`);
    const view = JSON.parse(res.out) as {
      number: number; title: string; body: string; author: { login: string; is_bot?: boolean }; isDraft: boolean;
      labels: { name: string }[]; baseRefName: string; headRefOid: string;
      reviews: { id?: string; author: { login: string; is_bot?: boolean }; state: string; body: string; commit?: { oid: string } }[];
    };
    const [checks, botThreads] = await Promise.all([checksFor(cwd, pr), botThreadsFor(cwd, pr)]);
    const bot = (login: string, flag?: boolean): boolean => Boolean(flag) || login.endsWith("[bot]") || login.startsWith("app/");
    return {
      number: view.number,
      title: view.title,
      body: view.body ?? "",
      author: view.author?.login ?? "",
      authorIsBot: bot(view.author?.login ?? "", view.author?.is_bot),
      isDraft: Boolean(view.isDraft),
      labels: (view.labels ?? []).map((l) => l.name),
      base: view.baseRefName,
      headSha: view.headRefOid,
      reviews: (view.reviews ?? []).map((r) => ({
        id: r.id ?? "",
        author: r.author?.login ?? "",
        state: r.state,
        body: r.body ?? "",
        isBot: bot(r.author?.login ?? "", r.author?.is_bot),
        commit: r.commit?.oid,
      })),
      checks,
      botThreads,
    };
  },
  prFiles: async (cwd, pr) => {
    const res = await sh(cwd, ["gh", "pr", "view", String(pr), "--json", "files", "--jq", ".files"]);
    if (res.code !== 0) throw new Error(`gh pr view ${pr} files: ${res.err}`);
    const files = JSON.parse(res.out || "[]") as { path: string; additions: number; deletions: number }[];
    return files.map((f) => ({ path: f.path, additions: f.additions ?? 0, deletions: f.deletions ?? 0 }));
  },
  prDiff: async (cwd, pr) => {
    const res = await sh(cwd, ["gh", "pr", "diff", String(pr)], 120_000);
    if (res.code !== 0) throw new Error(`gh pr diff ${pr}: ${res.err}`);
    return res.out;
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
    const [list, botThreads] = await Promise.all([checksFor(cwd, pr), botThreadsFor(cwd, pr)]);
    return {
      sha: view?.headRefOid ?? "",
      mergeable: view?.mergeable ?? "UNKNOWN",
      mergeState: view?.mergeStateStatus ?? "",
      checks: list,
      botThreads,
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
  failedLog: async (cwd, link) => {
    const match = link.match(/\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
    if (!match) return "";
    const [, runId, jobId] = match;
    const argv = jobId ? ["gh", "run", "view", "--job", jobId, "--log-failed"] : ["gh", "run", "view", runId, "--log-failed"];
    const res = await sh(cwd, argv, 120_000);
    return res.code === 0 ? res.out : "";
  },
};
