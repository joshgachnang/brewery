// GitHub reads and writes for `brewery cellar`. An interface so cellar can be tested
// without GitHub, like Ci for finish.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sh } from "./vcs.ts";

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
  createPr: (cwd: string, pr: NewPr) => Promise<string>;
  clone: (name: string, dir: string) => Promise<void>;
}

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
      "run", "list", "-R", name, "--status", "failure", "--created", `>=${searchDate(since)}`, "--limit", "100",
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
      "pr", "list", "-R", name, "--state", "merged", "--search", `merged:>=${searchDate(since)}`, "--limit", "100",
      "--json", "number,title,headRefName,mergedAt,url,author",
    ]);
    return prs.map((p) => ({ number: p.number, title: p.title, branch: p.headRefName, mergedAt: p.mergedAt, url: p.url, author: p.author?.login ?? "" }));
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
