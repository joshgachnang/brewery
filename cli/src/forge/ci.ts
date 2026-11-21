// The `Ci` that finish, barrel, and approve use, on whichever forge the checkout's origin is
// (GitHub through gh, Forgejo through its API). It calls the forge backends in-process, not
// the `forge` binary, so `brewery approve` works on CI runners where ~/bin/forge is absent.
import { backendFor } from "./main.ts";
import { resolveRepo } from "./resolve.ts";
import type { Backend, Thread } from "./types.ts";
import { unansweredBotThreads, type ChangedFile, type Check, type Ci, type PrSnapshot } from "../vcs.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// One backend per checkout; the origin does not change during a run.
const backends = new Map<string, Promise<Backend>>();
export const backendAt = (cwd: string): Promise<Backend> => {
  let b = backends.get(cwd);
  if (!b) {
    b = resolveRepo({ cwd }).then((resolved) => backendFor(resolved, cwd, process.env));
    backends.set(cwd, b);
  }
  return b;
};

// unansweredBotThreads reads GitHub's GraphQL node shape; forge threads carry isBot instead.
const botThreads = (threads: Thread[]) =>
  unansweredBotThreads(
    threads.map((t) => ({
      id: t.id,
      isResolved: t.isResolved,
      comments: {
        nodes: t.comments.map((c) => ({
          author: { __typename: c.author.isBot ? "Bot" : "User", login: c.author.login },
          path: t.path,
          line: t.line,
          body: c.body,
        })),
      },
    })),
  );

const toChecks = (checks: { name: string; bucket: Check["bucket"]; link: string }[]): Check[] =>
  checks.map((c) => ({ name: c.name, bucket: c.bucket, link: c.link || undefined }));

// Changed files with line counts, read from the unified diff: the same on both forges, and
// Forgejo's PR object has no file list.
export const filesFromDiff = (diff: string): ChangedFile[] => {
  const files: ChangedFile[] = [];
  let file: ChangedFile | null = null;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    const start = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (start) {
      file = { path: start[2], additions: 0, deletions: 0 };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;
    if (!inHunk) {
      const to = line.match(/^\+\+\+ b\/(.+)$/);
      if (to) file.path = to[1];
      if (line.startsWith("@@")) inHunk = true;
      continue;
    }
    if (line.startsWith("+")) file.additions++;
    else if (line.startsWith("-")) file.deletions++;
  }
  return files;
};

export const forgeCi: Ci = {
  prForBranch: async (cwd) => {
    try {
      return (await (await backendAt(cwd)).prView(undefined)).number;
    } catch {
      return null;
    }
  },
  prView: async (cwd, pr) => {
    const b = await backendAt(cwd);
    const [view, threads] = await Promise.all([b.prView(String(pr)), b.prThreads(String(pr))]);
    return {
      number: view.number,
      title: view.title,
      body: view.body ?? "",
      author: view.author.login,
      authorIsBot: view.author.isBot || view.author.login.startsWith("app/"),
      isDraft: view.isDraft,
      labels: view.labels.map((l) => l.name),
      base: view.baseRefName,
      headSha: view.headRefOid,
      reviews: view.reviews.map((r) => ({
        id: r.id,
        author: r.author.login,
        state: r.state,
        body: r.body,
        isBot: r.author.isBot || r.author.login.startsWith("app/"),
        commit: r.commit.oid || undefined,
      })),
      checks: toChecks(view.checks),
      botThreads: botThreads(threads),
    };
  },
  prFiles: async (cwd, pr) => filesFromDiff(await (await backendAt(cwd)).prDiff(String(pr))),
  prDiff: async (cwd, pr) => (await backendAt(cwd)).prDiff(String(pr)),
  prUrl: async (cwd, pr) => {
    const url = (await (await backendAt(cwd)).prView(String(pr))).url;
    if (!url) throw new Error(`forge pr view ${pr}: missing URL`);
    return url;
  },
  snapshot: async (cwd, pr) => {
    const b = await backendAt(cwd);
    let view = await b.prView(String(pr));
    // GitHub computes mergeability lazily; UNKNOWN usually settles within seconds. Forgejo
    // re-reads a false itself and reports UNKNOWN only once the PR is closed.
    for (let i = 0; i < 5 && view.forge === "github" && view.mergeable === "UNKNOWN"; i++) {
      await sleep(10_000);
      view = await b.prView(String(pr));
    }
    const threads = await b.prThreads(String(pr));
    const snap: PrSnapshot = {
      sha: view.headRefOid,
      mergeable: view.mergeable,
      mergeState: view.mergeStateStatus,
      checks: toChecks(view.checks),
      botThreads: botThreads(threads),
    };
    return snap;
  },
  waitForChecks: async (cwd, pr, timeoutMin) => {
    const b = await backendAt(cwd);
    const deadline = Date.now() + timeoutMin * 60_000;
    // Checks can take a few minutes to register after a push; give them five.
    const graceEnd = Math.min(Date.now() + 5 * 60_000, deadline);
    for (;;) {
      let checks: Check[] | null = null;
      try {
        checks = toChecks(await b.prChecks(String(pr)));
      } catch {
        // The forge not answering is not "no checks"; keep waiting until a bound hits.
      }
      if (checks && checks.length && !checks.some((c) => c.bucket === "pending")) return;
      if (Date.now() >= (checks?.length ? deadline : graceEnd)) return;
      await sleep(30_000);
    }
  },
  failedLog: async (cwd, link) => {
    const b = await backendAt(cwd);
    // GitHub: /actions/runs/<id>/job/<job id>. Forgejo: /actions/runs/<run number>/jobs/<position>.
    const github = link.match(/\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
    const forgejo = link.match(/\/actions\/runs\/(\d+)\/jobs\/(\d+)/);
    try {
      if (b.ref.forge === "forgejo" && forgejo) {
        // The link names the job by its position; runLogs takes the API job id.
        const job = (await b.runView(forgejo[1])).jobs[Number(forgejo[2])];
        return job ? await b.runLogs(forgejo[1], { failed: false, job: String(job.databaseId) }) : "";
      }
      if (!github) return "";
      return await b.runLogs(github[1], { failed: true, job: github[2] });
    } catch {
      return "";
    }
  },
};
