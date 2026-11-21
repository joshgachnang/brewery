// Forge reads and writes for `brewery cellar` and `calibrate`. An interface so cellar can be
// tested without a forge, like Ci for finish. `repoForge` picks the forge from the repo name:
// `owner/name` is GitHub (as it always was), `host/owner/name` is that host, which must be
// github.com or a Forgejo host in ~/.config/forge/hosts.json.
//
// GitHub keeps its search qualifiers (`merged:>=`, `updated:>=`), which Forgejo has no
// equivalent for. Forgejo lists PRs newest-updated first and filters the dates here, and says
// so on stderr when the window may hold more than one pass reads.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sh } from "../vcs.ts";
import { backendFor } from "./main.ts";
import { forgeFor, hostsPath, loadHosts, parseSlug } from "./resolve.ts";
import type { Backend } from "./types.ts";

export interface FailedRun {
  id: number;
  workflow: string;
  branch: string;
  sha: string;
  createdAt: string;
  url: string;
}

export interface MergedPr {
  number: number;
  title: string;
  branch: string;
  mergedAt: string;
  url: string;
  author: string;
}

// One thing a person (or bot) said on a PR: a review verdict, an inline comment on a
// line, or a conversation comment.
export interface ReviewNote {
  kind: "review" | "inline" | "comment";
  author: string;
  isBot: boolean;
  // APPROVED, CHANGES_REQUESTED, COMMENTED for reviews.
  state?: string;
  path?: string;
  line?: number;
  hunk?: string;
  body: string;
  at: string;
}

export interface ReviewedPr {
  number: number;
  title: string;
  url: string;
  author: string;
  state: "merged" | "closed" | "open";
  updatedAt: string;
  notes: ReviewNote[];
}

export interface NewPr {
  name: string;
  base: string;
  head: string;
  title: string;
  body: string;
}

export interface Forge {
  failedRuns: (name: string, since: string) => Promise<FailedRun[]>;
  runLog: (name: string, id: number) => Promise<string>;
  mergedPrs: (name: string, since: string) => Promise<MergedPr[]>;
  // PRs updated since the date with everything said on them, newest first.
  reviewedPrs: (name: string, since: string) => Promise<ReviewedPr[]>;
  createPr: (cwd: string, pr: NewPr) => Promise<string>;
  clone: (name: string, dir: string) => Promise<void>;
}

// How many recently updated PRs one calibrate pass reads (three API calls each).
const REVIEWED_PRS = 60;
// How many merged PRs or failed runs one cellar pass reads.
const PASS_LIMIT = 100;

// GitHub's search qualifiers take YYYY-MM-DDTHH:MM:SSZ, without milliseconds.
const searchDate = (iso: string): string => iso.replace(/\.\d+Z$/, "Z");

const ghJson = async <T>(argv: string[]): Promise<T> => {
  const res = await sh(process.cwd(), ["gh", ...argv]);
  if (res.code !== 0) throw new Error(`gh ${argv.slice(0, 2).join(" ")}: ${res.err || res.out}`);
  return JSON.parse(res.out || "[]") as T;
};

export const githubForge: Forge = {
  failedRuns: async (name, since) => {
    const runs = await ghJson<{ databaseId: number; workflowName: string; headBranch: string; headSha: string; createdAt: string; url: string }[]>([
      "run", "list", "-R", name, "--status", "failure", "--created", `>=${searchDate(since)}`, "--limit", String(PASS_LIMIT),
      "--json", "databaseId,workflowName,headBranch,headSha,createdAt,url",
    ]);
    return runs.map((r) => ({ id: r.databaseId, workflow: r.workflowName, branch: r.headBranch, sha: r.headSha, createdAt: r.createdAt, url: r.url }));
  },
  runLog: async (name, id) => {
    const res = await sh(process.cwd(), ["gh", "run", "view", String(id), "-R", name, "--log-failed"], 120_000);
    return res.code === 0 ? res.out : "";
  },
  mergedPrs: async (name, since) => {
    const prs = await ghJson<{ number: number; title: string; headRefName: string; mergedAt: string; url: string; author: { login: string } }[]>([
      "pr", "list", "-R", name, "--state", "merged", "--search", `merged:>=${searchDate(since)}`, "--limit", String(PASS_LIMIT),
      "--json", "number,title,headRefName,mergedAt,url,author",
    ]);
    return prs.map((p) => ({ number: p.number, title: p.title, branch: p.headRefName, mergedAt: p.mergedAt, url: p.url, author: p.author?.login ?? "" }));
  },
  reviewedPrs: async (name, since) => {
    const date = searchDate(since);
    const prs = await ghJson<{ number: number; title: string; url: string; state: string; updatedAt: string; author: { login: string } }[]>([
      "pr", "list", "-R", name, "--state", "all", "--search", `updated:>=${date} sort:updated-desc`, "--limit", String(REVIEWED_PRS),
      "--json", "number,title,url,state,updatedAt,author",
    ]);
    const bot = (user: { login?: string; type?: string } | null): boolean => !user || user.type === "Bot" || (user.login ?? "").endsWith("[bot]");
    const out: ReviewedPr[] = [];
    for (const pr of prs) {
      const [reviews, inline, comments] = await Promise.all([
        ghJson<{ user: { login: string; type: string } | null; state: string; body: string; submitted_at: string }[]>(["api", "--paginate", `repos/${name}/pulls/${pr.number}/reviews`]),
        ghJson<{ user: { login: string; type: string } | null; path: string; line: number | null; original_line: number | null; diff_hunk: string; body: string; created_at: string }[]>(["api", "--paginate", `repos/${name}/pulls/${pr.number}/comments?since=${date}`]),
        ghJson<{ user: { login: string; type: string } | null; body: string; created_at: string }[]>(["api", "--paginate", `repos/${name}/issues/${pr.number}/comments?since=${date}`]),
      ]);
      const notes: ReviewNote[] = [
        ...reviews.filter((r) => r.body || r.state !== "COMMENTED").map((r) => ({ kind: "review" as const, author: r.user?.login ?? "", isBot: bot(r.user), state: r.state, body: r.body ?? "", at: r.submitted_at ?? "" })),
        ...inline.map((c) => ({ kind: "inline" as const, author: c.user?.login ?? "", isBot: bot(c.user), path: c.path, line: c.line ?? c.original_line ?? undefined, hunk: c.diff_hunk, body: c.body ?? "", at: c.created_at })),
        ...comments.map((c) => ({ kind: "comment" as const, author: c.user?.login ?? "", isBot: bot(c.user), body: c.body ?? "", at: c.created_at })),
      ].sort((a, b) => a.at.localeCompare(b.at));
      out.push({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author?.login ?? "",
        state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "open",
        updatedAt: pr.updatedAt,
        notes,
      });
    }
    return out;
  },
  createPr: async (cwd, pr) => {
    const bodyFile = join(mkdtempSync(join(tmpdir(), "brewery-pr-")), "body.md");
    writeFileSync(bodyFile, pr.body);
    const res = await sh(cwd, ["gh", "pr", "create", "-R", pr.name, "--base", pr.base, "--head", pr.head, "--title", pr.title, "--body-file", bodyFile]);
    if (res.code !== 0) throw new Error(`gh pr create: ${res.err || res.out}`);
    return res.out.split("\n").at(-1) ?? "";
  },
  clone: async (name, dir) => {
    const res = await sh(process.cwd(), ["gh", "repo", "clone", name, dir, "--", "-q"]);
    if (res.code !== 0) throw new Error(`gh repo clone ${name}: ${res.err}`);
  },
};

const truncated = (what: string, name: string, n: number, limit: number): void => {
  if (n >= limit) console.error(`brewery: ${name}: read the newest ${limit} ${what}; older ones in the window were not read`);
};

// Forgejo through its API. No search qualifiers: list newest-updated first, filter by date.
export const forgejoForge = (b: Backend): Forge => ({
  failedRuns: async (name, since) => {
    // forge applies --created itself on Forgejo, over the newest 1000 runs.
    const runs = await b.runList({ limit: PASS_LIMIT, status: "failure", created: `>=${searchDate(since)}` });
    truncated("failed runs", name, runs.length, PASS_LIMIT);
    return runs.map((r) => ({ id: r.databaseId, workflow: r.workflowName, branch: r.headBranch, sha: r.headSha, createdAt: r.createdAt, url: r.url }));
  },
  runLog: async (_name, id) => {
    try {
      return await b.runLogs(String(id), { failed: true });
    } catch {
      return "";
    }
  },
  mergedPrs: async (name, since) => {
    // Every merged PR is read (forge pages closed PRs to the end), so the filter is exact.
    const prs = (await b.prList({ state: "merged", limit: Number.MAX_SAFE_INTEGER }))
      .filter((p) => (p.mergedAt ?? "") >= since)
      .sort((x, y) => (y.mergedAt ?? "").localeCompare(x.mergedAt ?? ""));
    truncated("merged PRs", name, prs.length, PASS_LIMIT);
    return prs.slice(0, PASS_LIMIT).map((p) => ({ number: p.number, title: p.title, branch: p.headRefName, mergedAt: p.mergedAt ?? "", url: p.url, author: p.author.login }));
  },
  reviewedPrs: async (name, since) => {
    // Newest-updated first, so the PRs updated since the date are a prefix of the list. Read
    // one past the cap to know whether the window held more.
    const prs = (await b.prList({ state: "all", limit: REVIEWED_PRS + 1 })).filter((p) => p.updatedAt >= since);
    truncated("updated PRs", name, prs.length, REVIEWED_PRS + 1);
    const out: ReviewedPr[] = [];
    for (const listed of prs.slice(0, REVIEWED_PRS)) {
      const [pr, threads] = await Promise.all([b.prView(String(listed.number)), b.prThreads(String(listed.number))]);
      // Forgejo threads have no diff hunk; notes carry path and line only.
      const notes: ReviewNote[] = [
        ...pr.reviews.filter((r) => r.body || r.state !== "COMMENTED").map((r) => ({ kind: "review" as const, author: r.author.login, isBot: r.author.isBot, state: r.state, body: r.body, at: r.submittedAt })),
        ...threads.flatMap((t) => t.comments.filter((c) => c.createdAt >= since).map((c) => ({ kind: "inline" as const, author: c.author.login, isBot: c.author.isBot, path: t.path, line: t.line ?? undefined, body: c.body, at: c.createdAt }))),
        ...pr.comments.filter((c) => c.createdAt >= since).map((c) => ({ kind: "comment" as const, author: c.author.login, isBot: c.author.isBot, body: c.body, at: c.createdAt })),
      ].sort((x, y) => x.at.localeCompare(y.at));
      out.push({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author.login,
        state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "open",
        updatedAt: pr.updatedAt,
        notes,
      });
    }
    return out;
  },
  createPr: async (_cwd, pr) => b.prCreate({ title: pr.title, body: pr.body, base: pr.base, head: pr.head, draft: false }),
  clone: async (_name, dir) => b.repoClone(dir, ["-q"]),
});

// The repo name's forge: `owner/name` is GitHub; `host/owner/name` names the host.
export const repoName = (name: string): { host: string; slug: string } => {
  const parsed = parseSlug(name);
  if (!parsed) throw new Error(`brewery: want owner/name or host/owner/name, got "${name}"`);
  return { host: parsed.host ?? "github.com", slug: `${parsed.owner}/${parsed.name}` };
};

const forgeOf = (name: string): { forge: Forge; slug: string } => {
  const { host, slug } = repoName(name);
  if (host === "github.com") return { forge: githubForge, slug };
  const [owner, repo] = slug.split("/");
  const resolved = forgeFor({ host, owner, name: repo }, loadHosts(hostsPath()));
  return { forge: forgejoForge(backendFor(resolved, process.cwd(), process.env)), slug };
};

// Each call resolves the name it is given, so one Forge serves every repo.
export const repoForge: Forge = {
  failedRuns: (name, since) => { const f = forgeOf(name); return f.forge.failedRuns(f.slug, since); },
  runLog: (name, id) => { const f = forgeOf(name); return f.forge.runLog(f.slug, id); },
  mergedPrs: (name, since) => { const f = forgeOf(name); return f.forge.mergedPrs(f.slug, since); },
  reviewedPrs: (name, since) => { const f = forgeOf(name); return f.forge.reviewedPrs(f.slug, since); },
  createPr: (cwd, pr) => { const f = forgeOf(pr.name); return f.forge.createPr(cwd, { ...pr, name: f.slug }); },
  clone: (name, dir) => { const f = forgeOf(name); return f.forge.clone(f.slug, dir); },
};
