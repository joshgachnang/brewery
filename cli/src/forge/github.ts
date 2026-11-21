// The GitHub side of `forge`: every call shells out to `gh`, then maps gh's JSON onto the
// shared schema in types.ts.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, sh } from "../vcs.ts";
import { actor, bucketFor, checksState, decideReviews } from "./rules.ts";
import {
  ForgeError,
  type Backend,
  type Bucket,
  type Check,
  type Comment,
  type Issue,
  type Job,
  type Pr,
  type RepoRef,
  type Review,
  type ReviewState,
  type Run,
  type RunConclusion,
  type RunStatus,
  type Thread,
} from "./types.ts";

export interface GithubOpts {
  gh?: string;
  cwd?: string;
}

const PR_FIELDS = "number,url,title,body,state,isDraft,author,headRefName,headRefOid,baseRefName,labels,mergeable,mergeStateStatus,reviewDecision,reviews,comments,createdAt,updatedAt,mergedAt,closedAt";
const PR_LIST_FIELDS = "number,url,title,body,state,isDraft,author,headRefName,headRefOid,baseRefName,labels,createdAt,updatedAt,mergedAt,closedAt";
const CHECK_FIELDS = "name,state,bucket,link,workflow,startedAt,completedAt,description,event";
const RUN_FIELDS = "databaseId,number,url,workflowName,displayTitle,headBranch,headSha,event,status,conclusion,createdAt,updatedAt,startedAt";
const ISSUE_FIELDS = "number,title,body,state,url,author,labels,assignees,createdAt,updatedAt,closedAt";

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes { id isResolved isOutdated path line originalLine
          comments(first: 100) { nodes { databaseId author { __typename login } body createdAt url } } }
      }
    }
  }
}`;

interface GhActor {
  login?: string;
  is_bot?: boolean;
  __typename?: string;
}

interface GhPr {
  number: number;
  url: string;
  title: string;
  body: string;
  state: string;
  isDraft: boolean;
  author: GhActor | null;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  labels: { name: string }[];
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  reviews?: { id: string; author: GhActor | null; state: string; body: string; submittedAt: string; commit?: { oid: string } }[];
  comments?: { id: string; author: GhActor | null; body: string; createdAt: string; url: string }[];
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
}

interface GhRun {
  databaseId: number;
  number: number;
  url: string;
  workflowName: string;
  displayTitle: string;
  headBranch: string;
  headSha: string;
  event: string;
  status: string;
  conclusion: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  jobs?: { databaseId: number; name: string; status: string; conclusion: string; url: string; startedAt: string; completedAt: string }[];
}

interface GhIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  author: GhActor | null;
  labels: { name: string }[];
  assignees: { login: string }[];
  comments?: { id?: string; author: GhActor | null; body: string; createdAt: string; url: string }[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

const ghActor = (a: GhActor | null | undefined): ReturnType<typeof actor> => actor(a?.login, [], a?.is_bot || a?.__typename === "Bot");

const reviewState = (state: string): ReviewState =>
  (["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"] as const).find((s) => s === state) ?? "COMMENTED";

const runStatus = (status: string): RunStatus => (status === "completed" ? "completed" : status === "in_progress" ? "in_progress" : "queued");

const runConclusion = (c: string): RunConclusion => {
  if (c === "success" || c === "skipped" || c === "cancelled") return c;
  if (!c) return "";
  return c === "neutral" ? "success" : "failure";
};

const BUCKETS: Bucket[] = ["pass", "fail", "pending", "skipping", "cancel"];

const toChecks = (raw: { name: string; state: string; bucket?: string; link?: string; workflow?: string; startedAt?: string; completedAt?: string; description?: string; event?: string }[]): Check[] =>
  raw.map((c) => ({
    name: c.name,
    state: (c.state ?? "").toUpperCase(),
    bucket: BUCKETS.includes(c.bucket as Bucket) ? (c.bucket as Bucket) : bucketFor(c.state ?? ""),
    link: c.link ?? "",
    workflow: c.workflow ?? "",
    description: c.description ?? "",
    startedAt: c.startedAt ?? "",
    completedAt: c.completedAt ?? "",
    event: c.event ?? "",
  }));

const toComment = (c: { id?: string; author: GhActor | null; body: string; createdAt: string; url: string }): Comment => ({
  id: c.id ?? "",
  author: ghActor(c.author),
  body: c.body ?? "",
  createdAt: c.createdAt,
  url: c.url ?? "",
});

export const toRun = (ref: RepoRef, r: GhRun): Run => ({
  forge: "github",
  repo: `${ref.owner}/${ref.name}`,
  databaseId: r.databaseId,
  number: r.number,
  url: r.url,
  workflowName: r.workflowName,
  displayTitle: r.displayTitle,
  headBranch: r.headBranch,
  headSha: r.headSha,
  event: r.event,
  status: runStatus(r.status),
  conclusion: runConclusion(r.conclusion),
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  startedAt: r.startedAt,
  jobs: (r.jobs ?? []).map((j): Job => ({
    databaseId: j.databaseId,
    name: j.name,
    status: runStatus(j.status),
    conclusion: runConclusion(j.conclusion),
    url: j.url,
    startedAt: j.startedAt,
    completedAt: j.completedAt,
  })),
});

const toIssue = (ref: RepoRef, i: GhIssue): Issue => ({
  forge: "github",
  repo: `${ref.owner}/${ref.name}`,
  number: i.number,
  url: i.url,
  title: i.title,
  body: i.body ?? "",
  state: i.state === "CLOSED" ? "CLOSED" : "OPEN",
  author: ghActor(i.author),
  labels: (i.labels ?? []).map((l) => ({ name: l.name })),
  assignees: (i.assignees ?? []).map((a) => ({ login: a.login })),
  comments: (i.comments ?? []).map(toComment),
  createdAt: i.createdAt,
  updatedAt: i.updatedAt,
  closedAt: i.closedAt ?? null,
});

// PR or issue number from a selector that is a number or a URL; anything else (a branch)
// passes through for gh to resolve.
const selector = (sel: string | undefined): string[] => {
  if (!sel) return [];
  const fromUrl = sel.match(/\/(?:pull|pulls|issues)\/(\d+)/);
  return [fromUrl ? fromUrl[1] : sel];
};

const runId = (id: string): string => id.match(/\/actions\/runs\/(\d+)/)?.[1] ?? id;

const withBodyFile = async <T>(body: string, use: (file: string) => Promise<T>): Promise<T> => {
  const dir = mkdtempSync(join(tmpdir(), "forge-body-"));
  try {
    const file = join(dir, "body.md");
    writeFileSync(file, body);
    return await use(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const githubBackend = (ref: RepoRef, opts: GithubOpts = {}): Backend => {
  const gh = opts.gh ?? "gh";
  const cwd = opts.cwd ?? process.cwd();
  const slug = `${ref.owner}/${ref.name}`;
  const repoArgs = ["-R", slug];

  // gh refuses a PR command without an argument once -R is given, so no selector means the
  // current branch, named explicitly.
  const current = async (sel: string | undefined): Promise<string> => sel ?? (await git(cwd, "rev-parse", "--abbrev-ref", "HEAD"));

  const run = async (argv: string[], allow: number[] = [0], timeoutMs?: number): Promise<string> => {
    const res = await sh(cwd, [gh, ...argv], timeoutMs);
    if (!allow.includes(res.code)) throw new ForgeError(`forge: gh ${argv.slice(0, 2).join(" ")}: ${res.err || res.out}`);
    return res.out;
  };
  const json = async <T>(argv: string[], allow?: number[]): Promise<T> => {
    const out = await run(argv, allow);
    return JSON.parse(out || "null") as T;
  };

  const checksFor = async (sel: string | undefined): Promise<Check[]> => {
    // gh exits 8 while checks are pending and 1 with "no checks reported"; both are answers.
    const res = await sh(cwd, [gh, "pr", "checks", ...selector(await current(sel)), ...repoArgs, "--json", CHECK_FIELDS]);
    if (res.out.startsWith("[")) return toChecks(JSON.parse(res.out));
    if (/no checks reported/i.test(res.err) || res.code === 0) return [];
    throw new ForgeError(`forge: gh pr checks: ${res.err || res.out}`);
  };

  const toPr = (p: GhPr, checks: Check[]): Pr => {
    const reviews: Review[] = (p.reviews ?? []).map((r) => ({
      id: r.id,
      author: ghActor(r.author),
      state: reviewState(r.state),
      body: r.body ?? "",
      submittedAt: r.submittedAt ?? "",
      commit: { oid: r.commit?.oid ?? "" },
      stale: false,
    }));
    const author = ghActor(p.author);
    const decision = p.reviewDecision === "APPROVED" || p.reviewDecision === "CHANGES_REQUESTED" || p.reviewDecision === "REVIEW_REQUIRED"
      ? p.reviewDecision
      : decideReviews(reviews, author.login);
    const mergeable = p.mergeable === "MERGEABLE" || p.mergeable === "CONFLICTING" ? p.mergeable : "UNKNOWN";
    return {
      forge: "github",
      repo: slug,
      number: p.number,
      url: p.url,
      title: p.title,
      body: p.body ?? "",
      state: p.state === "MERGED" ? "MERGED" : p.state === "CLOSED" ? "CLOSED" : "OPEN",
      isDraft: Boolean(p.isDraft),
      author,
      headRefName: p.headRefName,
      headRefOid: p.headRefOid,
      baseRefName: p.baseRefName,
      labels: (p.labels ?? []).map((l) => ({ name: l.name })),
      mergeable,
      mergeStateStatus: p.mergeStateStatus ?? "UNKNOWN",
      reviewDecision: decision,
      reviews,
      comments: (p.comments ?? []).map(toComment),
      checks,
      checksState: checksState(checks),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      mergedAt: p.mergedAt ?? null,
      closedAt: p.closedAt ?? null,
    };
  };

  const prView = async (sel: string | undefined): Promise<Pr> => {
    const [p, checks] = await Promise.all([
      json<GhPr>(["pr", "view", ...selector(await current(sel)), ...repoArgs, "--json", PR_FIELDS]),
      checksFor(sel),
    ]);
    return toPr(p, checks);
  };

  return {
    ref,
    prView,
    prList: async (o) => {
      const argv = ["pr", "list", ...repoArgs, "--state", o.state, "--limit", String(o.limit), "--json", PR_LIST_FIELDS];
      if (o.head) argv.push("--head", o.head);
      if (o.base) argv.push("--base", o.base);
      if (o.author) argv.push("--author", o.author);
      if (o.label) argv.push("--label", o.label);
      if (o.search) argv.push("--search", o.search);
      return (await json<GhPr[]>(argv)).map((p) => toPr(p, []));
    },
    prCreate: async (o) =>
      withBodyFile(o.body, async (file) => {
        const argv = ["pr", "create", ...repoArgs, "--title", o.title, "--body-file", file, "--head", o.head];
        if (o.base) argv.push("--base", o.base);
        if (o.draft) argv.push("--draft");
        return (await run(argv)).split("\n").at(-1) ?? "";
      }),
    prDiff: async (sel) => run(["pr", "diff", ...selector(await current(sel)), ...repoArgs], [0], 120_000),
    prChecks: checksFor,
    prMerge: async (sel, o) => {
      const argv = ["pr", "merge", ...selector(await current(sel)), ...repoArgs, `--${o.method}`];
      if (o.matchHead) argv.push("--match-head-commit", o.matchHead);
      if (o.deleteBranch) argv.push("--delete-branch");
      await run(argv);
    },
    prComment: async (sel, body) =>
      withBodyFile(body, async (file) => (await run(["pr", "comment", ...selector(await current(sel)), ...repoArgs, "--body-file", file])).split("\n").at(-1) ?? ""),
    prThreads: async (sel) => {
      const number = sel && /^\d+$/.test(selector(sel)[0]) ? Number(selector(sel)[0]) : (await prView(sel)).number;
      const data = await json<{ data: { repository: { pullRequest: { reviewThreads: { nodes: {
        id: string; isResolved: boolean; isOutdated: boolean; path: string; line: number | null; originalLine: number | null;
        comments: { nodes: { databaseId: number; author: GhActor | null; body: string; createdAt: string; url: string }[] };
      }[] } } } } }>(["api", "graphql", "-F", `owner=${ref.owner}`, "-F", `name=${ref.name}`, "-F", `number=${number}`, "-f", `query=${THREADS_QUERY}`]);
      return data.data.repository.pullRequest.reviewThreads.nodes.map((t): Thread => ({
        id: t.id,
        path: t.path,
        line: t.line ?? t.originalLine ?? null,
        isResolved: t.isResolved,
        isOutdated: t.isOutdated,
        comments: t.comments.nodes.map((c) => ({ id: String(c.databaseId), author: ghActor(c.author), body: c.body ?? "", createdAt: c.createdAt, url: c.url })),
      }));
    },
    runList: async (o) => {
      const argv = ["run", "list", ...repoArgs, "--limit", String(o.limit), "--json", RUN_FIELDS];
      if (o.branch) argv.push("--branch", o.branch);
      if (o.commit) argv.push("--commit", o.commit);
      if (o.workflow) argv.push("--workflow", o.workflow);
      if (o.status) argv.push("--status", o.status);
      if (o.event) argv.push("--event", o.event);
      return (await json<GhRun[]>(argv)).map((r) => toRun(ref, r));
    },
    runView: async (id) => toRun(ref, await json<GhRun>(["run", "view", runId(id), ...repoArgs, "--json", `${RUN_FIELDS},jobs`])),
    runRerun: async (id, o) => {
      const argv = o.job ? ["run", "rerun", ...repoArgs, "--job", o.job] : ["run", "rerun", runId(id), ...repoArgs];
      if (o.failed && !o.job) argv.push("--failed");
      await run(argv);
    },
    runLogs: async (id, o) => {
      const argv = o.job ? ["run", "view", ...repoArgs, "--job", o.job] : ["run", "view", runId(id), ...repoArgs];
      argv.push(o.failed ? "--log-failed" : "--log");
      return run(argv, [0], 120_000);
    },
    issueList: async (o) => {
      const argv = ["issue", "list", ...repoArgs, "--state", o.state, "--limit", String(o.limit), "--json", ISSUE_FIELDS];
      if (o.label) argv.push("--label", o.label);
      if (o.search) argv.push("--search", o.search);
      return (await json<GhIssue[]>(argv)).map((i) => toIssue(ref, i));
    },
    issueView: async (sel) => toIssue(ref, await json<GhIssue>(["issue", "view", ...selector(sel), ...repoArgs, "--json", `${ISSUE_FIELDS},comments`])),
    issueClose: async (sel, o) => {
      const argv = ["issue", "close", ...selector(sel), ...repoArgs];
      if (o.comment) argv.push("--comment", o.comment);
      if (o.reason) argv.push("--reason", o.reason);
      await run(argv);
    },
    issueComment: async (sel, body) =>
      withBodyFile(body, async (file) => (await run(["issue", "comment", ...selector(sel), ...repoArgs, "--body-file", file])).split("\n").at(-1) ?? ""),
    issueLabel: async (sel, add, remove) => {
      const argv = ["issue", "edit", ...selector(sel), ...repoArgs];
      if (add.length) argv.push("--add-label", add.join(","));
      if (remove.length) argv.push("--remove-label", remove.join(","));
      await run(argv);
      const after = await json<{ labels: { name: string }[] }>(["issue", "view", ...selector(sel), ...repoArgs, "--json", "labels"]);
      return after.labels.map((l) => l.name);
    },
    repoView: async () => {
      const r = await json<{ name: string; owner: { login: string }; nameWithOwner: string; url: string; sshUrl: string; defaultBranchRef: { name: string } | null; isPrivate: boolean }>(
        ["repo", "view", slug, "--json", "name,owner,nameWithOwner,url,sshUrl,defaultBranchRef,isPrivate"],
      );
      return {
        forge: "github",
        host: ref.host,
        name: r.name,
        owner: { login: r.owner.login },
        nameWithOwner: r.nameWithOwner,
        url: r.url,
        sshUrl: r.sshUrl,
        cloneUrl: `${r.url}.git`,
        defaultBranchRef: { name: r.defaultBranchRef?.name ?? "" },
        isPrivate: r.isPrivate,
      };
    },
    repoClone: async (dir, gitArgs) => {
      const proc = Bun.spawn([gh, "repo", "clone", slug, ...(dir ? [dir] : []), ...(gitArgs.length ? ["--", ...gitArgs] : [])], { cwd, stdio: ["inherit", "inherit", "inherit"] });
      if ((await proc.exited) !== 0) throw new ForgeError(`forge: gh repo clone ${slug} failed`);
    },
    api: async (args) => {
      const proc = Bun.spawn([gh, "api", ...args], { cwd, stdio: ["inherit", "inherit", "inherit"] });
      return proc.exited;
    },
  };
};
