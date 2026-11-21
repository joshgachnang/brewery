// The Forgejo side of `forge`: the REST API at <host>/api/v1 with the host's token, mapped
// onto the shared schema in types.ts. Shapes verified against Forgejo 16.0.2; the recorded
// responses live in cli/test/fixtures/forge/forgejo.
import { readFileSync } from "node:fs";
import { git } from "../vcs.ts";
import { emit } from "./output.ts";
import { actor, bucketFor, checksState, createdMatches, decideReviews, forgejoThreads, WIP_PREFIX, type ForgejoReviewComment } from "./rules.ts";
import type { HostEntry } from "./resolve.ts";
import {
  ForgeError,
  type Backend,
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
} from "./types.ts";

export interface ForgejoOpts {
  entry: HostEntry;
  token?: string;
  cwd?: string;
  fetch?: typeof fetch;
  // How long to wait between re-reads while Forgejo recomputes mergeability after a push.
  pollMs?: number;
}

interface FUser {
  login: string;
}

interface FPr {
  number: number;
  html_url: string;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  user: FUser | null;
  // ref turns into refs/pull/N/head once the branch is deleted; label keeps the branch name.
  head: { ref: string; sha: string; label?: string };
  base: { ref: string };
  labels: { name: string }[] | null;
  mergeable: boolean;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
}

interface FReview {
  id: number;
  user: FUser | null;
  state: string;
  body: string;
  commit_id: string;
  stale: boolean;
  dismissed: boolean;
  submitted_at: string;
  comments_count: number;
}

interface FComment {
  id: number;
  user: FUser | null;
  body: string;
  created_at: string;
  html_url: string;
}

interface FStatus {
  status: string;
  context: string;
  target_url: string;
  description: string;
  created_at: string;
  updated_at: string;
}

interface FRun {
  id: number;
  index_in_repo: number;
  title: string;
  workflow_id: string;
  prettyref: string;
  commit_sha: string;
  event: string;
  trigger_event: string;
  status: string;
  created: string;
  updated: string;
  started: string;
  html_url: string;
}

interface FJob {
  id: number;
  run_id: number;
  name: string;
  status: string;
}

interface FIssue {
  number: number;
  html_url: string;
  title: string;
  body: string;
  state: "open" | "closed";
  user: FUser | null;
  labels: { name: string }[] | null;
  assignees: FUser[] | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: unknown;
}

const PAGE = 50;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const reviewState = (r: FReview): ReviewState | null => {
  if (r.dismissed) return "DISMISSED";
  switch (r.state) {
    case "APPROVED":
      return "APPROVED";
    case "REQUEST_CHANGES":
      return "CHANGES_REQUESTED";
    case "COMMENT":
      return "COMMENTED";
    case "PENDING":
      return "PENDING";
    default:
      // REQUEST_REVIEW is a "review requested" marker, not a review.
      return null;
  }
};

export const runStatus = (status: string): RunStatus => {
  if (status === "running") return "in_progress";
  if (["success", "failure", "cancelled", "skipped"].includes(status)) return "completed";
  return "queued";
};

export const runConclusion = (status: string): RunConclusion =>
  status === "success" || status === "failure" || status === "cancelled" || status === "skipped" ? status : "";

// gh --log-failed lines read "<job>\t<step>\t<timestamp> <text>", which failureExcerpt in
// ci.ts expects. Forgejo's job log has no step column, so it is marked like gh marks one.
const ghStyleLog = (job: string, log: string): string =>
  log.split("\n").filter((line) => line.length > 0).map((line) => `${job}\tUNKNOWN STEP\t${line}`).join("\n");

export const forgejoBackend = (ref: RepoRef, opts: ForgejoOpts): Backend => {
  const doFetch = opts.fetch ?? fetch;
  const cwd = opts.cwd ?? process.cwd();
  const web = opts.entry.url;
  const base = `${web}/api/v1`;
  const repoPath = `/repos/${ref.owner}/${ref.name}`;
  const slug = `${ref.owner}/${ref.name}`;
  const bots = opts.entry.bots ?? [];
  const pollMs = opts.pollMs ?? 2_000;
  const who = (u: FUser | null | undefined): ReturnType<typeof actor> => actor(u?.login, bots);

  const request = async (method: string, path: string, init: { query?: Record<string, string | number | undefined>; body?: unknown; raw?: string } = {}): Promise<Response> => {
    if (!opts.token) throw new ForgeError(`forge: no token for ${ref.host}; set "token" in its hosts.json entry or FORGEJO_TOKEN`);
    const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Authorization: `token ${opts.token}`, Accept: "application/json" };
    let body: string | undefined;
    if (init.raw !== undefined) {
      body = init.raw;
      headers["Content-Type"] = "application/json";
    } else if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers["Content-Type"] = "application/json";
    }
    return doFetch(url, { method, headers, body, signal: AbortSignal.timeout(120_000) });
  };

  const failure = async (method: string, path: string, res: Response): Promise<ForgeError> => {
    const text = await res.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      // not JSON; keep the text
    }
    return new ForgeError(`forge: ${method} ${path}: HTTP ${res.status} ${message}`.trim());
  };

  const call = async <T>(method: string, path: string, init: { query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<T> => {
    const res = await request(method, path, init);
    if (!res.ok) throw await failure(method, path, res);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  };

  const text = async (path: string): Promise<string> => {
    const res = await request("GET", path);
    if (!res.ok) throw await failure("GET", path, res);
    return res.text();
  };

  // Every page of a list endpoint, up to `max` items. `pick` reads the items out of wrapped
  // responses such as the runs list.
  const paged = async <T>(path: string, query: Record<string, string | number | undefined>, max = Infinity, pick: (body: unknown) => T[] = (b) => (b as T[] | null) ?? []): Promise<T[]> => {
    const out: T[] = [];
    for (let page = 1; out.length < max; page++) {
      const items = pick(await call<unknown>("GET", path, { query: { ...query, page, limit: PAGE } }));
      out.push(...items);
      if (items.length < PAGE) break;
    }
    return out.slice(0, max);
  };

  const prNumber = async (sel: string | undefined): Promise<number> => {
    if (sel && /^\d+$/.test(sel)) return Number(sel);
    const fromUrl = sel?.match(/\/pulls?\/(\d+)/);
    if (fromUrl) return Number(fromUrl[1]);
    const branch = sel ?? (await git(cwd, "rev-parse", "--abbrev-ref", "HEAD"));
    const open = await paged<FPr>(`${repoPath}/pulls`, { state: "open", head: branch });
    const match = open.find((p) => p.head.ref === branch);
    if (!match) throw new ForgeError(`forge: no open pull request for branch ${branch} in ${slug}`);
    return match.number;
  };

  const absolute = (link: string): string => (link.startsWith("/") ? `${web}${link}` : link);

  const statusChecks = async (sha: string): Promise<Check[]> => {
    const statuses = await paged<FStatus>(`${repoPath}/commits/${sha}/status`, {}, Infinity, (b) => (b as { statuses: FStatus[] | null }).statuses ?? []);
    return statuses.map((s) => {
      const pending = bucketFor(s.status) === "pending";
      return {
        name: s.context,
        state: s.status.toUpperCase(),
        bucket: bucketFor(s.status),
        link: absolute(s.target_url ?? ""),
        workflow: s.context.includes(" / ") ? s.context.split(" / ")[0] : "",
        description: s.description ?? "",
        startedAt: s.created_at ?? "",
        completedAt: pending ? "" : s.updated_at ?? "",
        event: s.context.match(/\(([^)]+)\)$/)?.[1] ?? "",
      };
    });
  };

  const reviewsFor = async (n: number): Promise<{ reviews: Review[]; raw: FReview[] }> => {
    const raw = await paged<FReview>(`${repoPath}/pulls/${n}/reviews`, {});
    const reviews = raw.flatMap((r): Review[] => {
      const state = reviewState(r);
      return state ? [{ id: String(r.id), author: who(r.user), state, body: r.body ?? "", submittedAt: r.submitted_at ?? "", commit: { oid: r.commit_id ?? "" }, stale: Boolean(r.stale) }] : [];
    });
    return { reviews, raw };
  };

  const toComment = (c: FComment): Comment => ({ id: String(c.id), author: who(c.user), body: c.body ?? "", createdAt: c.created_at, url: c.html_url });

  // Forgejo reports mergeable=false while it recomputes after a push, so a false is re-read
  // a few times before it is believed.
  const fetchPr = async (n: number): Promise<FPr> => {
    let pr = await call<FPr>("GET", `${repoPath}/pulls/${n}`);
    for (let i = 0; i < 3 && pr.state === "open" && !pr.mergeable; i++) {
      await sleep(pollMs);
      pr = await call<FPr>("GET", `${repoPath}/pulls/${n}`);
    }
    return pr;
  };

  const prView = async (sel: string | undefined): Promise<Pr> => {
    const n = await prNumber(sel);
    const raw = await fetchPr(n);
    const [{ reviews }, comments, checks] = await Promise.all([
      reviewsFor(n),
      call<FComment[]>("GET", `${repoPath}/issues/${n}/comments`),
      statusChecks(raw.head.sha),
    ]);
    return toPr(raw, reviews, (comments ?? []).map(toComment), checks);
  };

  const toPr = (p: FPr, reviews: Review[], comments: Comment[], checks: Check[]): Pr => {
    const author = who(p.user);
    const state = p.merged ? "MERGED" : p.state === "closed" ? "CLOSED" : "OPEN";
    const mergeable = state !== "OPEN" ? "UNKNOWN" : p.mergeable ? "MERGEABLE" : "CONFLICTING";
    const verdict = checksState(checks);
    const mergeStateStatus = state !== "OPEN"
      ? "UNKNOWN"
      : p.draft ? "DRAFT" : mergeable === "CONFLICTING" ? "DIRTY" : verdict === "red" || verdict === "running" ? "UNSTABLE" : "CLEAN";
    return {
      forge: "forgejo",
      repo: slug,
      number: p.number,
      url: p.html_url,
      title: p.title,
      body: p.body ?? "",
      state,
      isDraft: Boolean(p.draft),
      author,
      headRefName: p.head.ref.startsWith("refs/pull/") && p.head.label ? p.head.label : p.head.ref,
      headRefOid: p.head.sha,
      baseRefName: p.base.ref,
      labels: (p.labels ?? []).map((l) => ({ name: l.name })),
      mergeable,
      mergeStateStatus,
      reviewDecision: decideReviews(reviews, author.login),
      reviews,
      comments,
      checks,
      checksState: verdict,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      mergedAt: p.merged_at ?? null,
      closedAt: p.closed_at ?? null,
    };
  };

  const toRun = (r: FRun, jobs: FJob[] = []): Run => ({
    forge: "forgejo",
    repo: slug,
    databaseId: r.index_in_repo,
    number: r.index_in_repo,
    url: r.html_url,
    workflowName: r.workflow_id,
    displayTitle: r.title,
    headBranch: r.prettyref,
    headSha: r.commit_sha,
    event: r.trigger_event || r.event,
    status: runStatus(r.status),
    conclusion: runConclusion(r.status),
    createdAt: r.created,
    updatedAt: r.updated,
    startedAt: r.started,
    // A job's link is its position in the run (/jobs/0, /jobs/1, ...), as the web UI and the
    // commit statuses' target_url number them.
    jobs: jobs.map((j, i): Job => ({
      databaseId: j.id,
      name: j.name,
      status: runStatus(j.status),
      conclusion: runConclusion(j.status),
      url: `${r.html_url}/jobs/${i}`,
      startedAt: "",
      completedAt: "",
    })),
  });

  // The API keys runs by a global id; URLs and `forge run` take the per-repo run number.
  const runByNumber = async (id: string): Promise<FRun> => {
    const n = id.match(/\/actions\/runs\/(\d+)/)?.[1] ?? id;
    if (!/^\d+$/.test(n)) throw new ForgeError(`forge: ${id} is not a run number or run URL`);
    const found = await call<{ workflow_runs: FRun[] | null }>("GET", `${repoPath}/actions/runs`, { query: { run_number: n } });
    const run = (found.workflow_runs ?? []).find((r) => r.index_in_repo === Number(n));
    if (!run) throw new ForgeError(`forge: no run ${n} in ${slug}`);
    return run;
  };

  const jobsFor = async (run: FRun): Promise<FJob[]> => (await call<FJob[] | null>("GET", `${repoPath}/actions/runs/${run.id}/jobs`)) ?? [];

  const toIssue = (i: FIssue, comments: Comment[] = []): Issue => ({
    forge: "forgejo",
    repo: slug,
    number: i.number,
    url: i.html_url,
    title: i.title,
    body: i.body ?? "",
    state: i.state === "closed" ? "CLOSED" : "OPEN",
    author: who(i.user),
    labels: (i.labels ?? []).map((l) => ({ name: l.name })),
    assignees: (i.assignees ?? []).map((a) => ({ login: a.login })),
    comments,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    closedAt: i.closed_at ?? null,
  });

  const issueNumber = (sel: string): number => {
    const n = sel.match(/\/(?:issues|pulls?)\/(\d+)/)?.[1] ?? sel;
    if (!/^\d+$/.test(n)) throw new ForgeError(`forge: ${sel} is not an issue number or URL`);
    return Number(n);
  };

  // Labels go on by name and come off by name, on issues and PRs alike.
  const relabel = async (n: number, add: string[], remove: string[]): Promise<string[]> => {
    if (add.length) await call("POST", `${repoPath}/issues/${n}/labels`, { body: { labels: add } });
    for (const name of remove) await call("DELETE", `${repoPath}/issues/${n}/labels/${encodeURIComponent(name)}`);
    return ((await call<{ name: string }[] | null>("GET", `${repoPath}/issues/${n}/labels`)) ?? []).map((l) => l.name);
  };

  const repoLabels = async (): Promise<{ id: number; name: string; color: string; description: string }[]> => paged(`${repoPath}/labels`, {});

  const comment = async (n: number, body: string): Promise<string> =>
    (await call<FComment>("POST", `${repoPath}/issues/${n}/comments`, { body: { body } })).html_url;

  return {
    ref,
    prView,
    prList: async (o) => {
      const state = o.state === "merged" ? "closed" : o.state;
      if (o.search) throw new ForgeError("forge: pr list --search is GitHub-only; Forgejo's pull list has no search");
      const max = o.state === "merged" || o.state === "closed" || o.head ? Infinity : o.limit;
      // gh's @me is the token's own user.
      const poster = o.author === "@me" ? (await call<FUser>("GET", "/user")).login : o.author;
      const raw = await paged<FPr>(`${repoPath}/pulls`, { state, head: o.head, base: o.base, poster, labels: o.label, sort: "recentupdate" }, max);
      return raw
        .filter((p) => (o.state === "merged" ? p.merged : o.state === "closed" ? !p.merged : true))
        .filter((p) => !o.head || p.head.ref === o.head)
        .filter((p) => !o.base || p.base.ref === o.base)
        .slice(0, o.limit)
        .map((p) => toPr(p, [], [], []));
    },
    prCreate: async (o) => {
      const repo = o.base ? null : await call<{ default_branch: string }>("GET", repoPath);
      const created = await call<FPr>("POST", `${repoPath}/pulls`, {
        body: { title: o.draft && !/^(WIP|\[WIP\])/i.test(o.title) ? `WIP: ${o.title}` : o.title, body: o.body, head: o.head, base: o.base ?? repo?.default_branch },
      });
      return created.html_url;
    },
    prDiff: async (sel) => text(`${repoPath}/pulls/${await prNumber(sel)}.diff`),
    prChecks: async (sel) => {
      const n = await prNumber(sel);
      const pr = await call<FPr>("GET", `${repoPath}/pulls/${n}`);
      return statusChecks(pr.head.sha);
    },
    prMerge: async (sel, o) => {
      const n = await prNumber(sel);
      const pr = await fetchPr(n);
      if (pr.merged) throw new ForgeError(`forge: ${slug}#${n} is already merged`);
      if (pr.state !== "open") throw new ForgeError(`forge: ${slug}#${n} is closed`);
      // Compare here as well as sending head_commit_id: the message is clearer, and the
      // server-side check (409 "head out of date") still covers a push between the two.
      if (o.matchHead && pr.head.sha !== o.matchHead) {
        throw new ForgeError(`forge: not merging ${slug}#${n}: head is ${pr.head.sha}, not ${o.matchHead}`);
      }
      const path = `${repoPath}/pulls/${n}/merge`;
      const res = await request("POST", path, {
        body: { Do: o.method, ...(o.matchHead ? { head_commit_id: o.matchHead } : {}), ...(o.deleteBranch ? { delete_branch_after_merge: true } : {}) },
      });
      if (res.ok) return;
      const error = await failure("POST", path, res);
      if (res.status === 409 && /head out of date/i.test(error.message)) {
        throw new ForgeError(`forge: not merging ${slug}#${n}: the head moved past ${o.matchHead} (Forgejo: head out of date)`);
      }
      throw error;
    },
    prComment: async (sel, body) => comment(await prNumber(sel), body),
    prThreads: async (sel) => {
      const n = await prNumber(sel);
      const { raw } = await reviewsFor(n);
      const lists = await Promise.all(
        raw.filter((r) => r.comments_count > 0).map((r) => call<ForgejoReviewComment[] | null>("GET", `${repoPath}/pulls/${n}/reviews/${r.id}/comments`)),
      );
      return forgejoThreads(lists.flatMap((l) => l ?? []), bots);
    },
    prReady: async (sel, undo) => {
      const n = await prNumber(sel);
      const pr = await call<FPr>("GET", `${repoPath}/pulls/${n}`);
      const title = undo ? (WIP_PREFIX.test(pr.title) ? pr.title : `WIP: ${pr.title}`) : pr.title.replace(WIP_PREFIX, "");
      if (title !== pr.title) await call("PATCH", `${repoPath}/pulls/${n}`, { body: { title } });
    },
    prEdit: async (sel, o) => {
      const n = await prNumber(sel);
      const patch: Record<string, string> = {};
      if (o.title !== undefined) {
        // Keep a draft a draft: Forgejo's draft flag is the WIP prefix on the title.
        const current = await call<FPr>("GET", `${repoPath}/pulls/${n}`);
        const wip = current.title.match(WIP_PREFIX)?.[0];
        patch.title = wip && !WIP_PREFIX.test(o.title) ? `${wip}${o.title}` : o.title;
      }
      if (o.body !== undefined) patch.body = o.body;
      if (Object.keys(patch).length) await call("PATCH", `${repoPath}/pulls/${n}`, { body: patch });
      if (o.addReviewers.length) await call("POST", `${repoPath}/pulls/${n}/requested_reviewers`, { body: { reviewers: o.addReviewers } });
      if (o.removeReviewers.length) await call("DELETE", `${repoPath}/pulls/${n}/requested_reviewers`, { body: { reviewers: o.removeReviewers } });
      if (o.addLabels.length || o.removeLabels.length) await relabel(n, o.addLabels, o.removeLabels);
    },
    prReview: async (sel, event, body) => {
      const n = await prNumber(sel);
      const pr = await call<FPr>("GET", `${repoPath}/pulls/${n}`);
      const kind = event === "approve" ? "APPROVED" : event === "request-changes" ? "REQUEST_CHANGES" : "COMMENT";
      if (kind !== "APPROVED" && !body) throw new ForgeError(`forge: --${event} needs --body`);
      const review = await call<{ html_url?: string }>("POST", `${repoPath}/pulls/${n}/reviews`, { body: { event: kind, body, commit_id: pr.head.sha } });
      return review.html_url ?? "";
    },
    runList: async (o) => {
      if (o.created) {
        // Forgejo's runs list has no date filter; page through and filter here.
        const all = await paged<FRun>(`${repoPath}/actions/runs`, {
          ref: o.branch ? `refs/heads/${o.branch}` : undefined, head_sha: o.commit, workflow_id: o.workflow, status: o.status, event: o.event,
        }, 1_000, (b) => (b as { workflow_runs: FRun[] | null }).workflow_runs ?? []);
        return all.filter((r) => createdMatches(o.created as string, r.created)).slice(0, o.limit).map((r) => toRun(r));
      }
      const raw = await paged<FRun>(`${repoPath}/actions/runs`, {
        ref: o.branch ? `refs/heads/${o.branch}` : undefined,
        head_sha: o.commit,
        workflow_id: o.workflow,
        status: o.status,
        event: o.event,
      }, o.limit, (b) => (b as { workflow_runs: FRun[] | null }).workflow_runs ?? []);
      return raw.map((r) => toRun(r));
    },
    runView: async (id) => {
      const run = await runByNumber(id);
      return toRun(run, await jobsFor(run));
    },
    runRerun: async (id) => {
      const run = await runByNumber(id);
      throw new ForgeError(
        `forge: Forgejo has no API to rerun a run (its Re-run button needs a browser session); rerun ${run.html_url} from the web UI or push a new commit`,
        2,
      );
    },
    runLogs: async (id, o) => {
      const run = await runByNumber(id);
      const jobs = await jobsFor(run);
      const chosen = jobs.filter((j) => (o.job ? String(j.id) === o.job : o.failed ? j.status === "failure" : true));
      if (o.job && chosen.length === 0) throw new ForgeError(`forge: run ${id} has no job ${o.job}`);
      const logs = await Promise.all(chosen.map(async (j) => ghStyleLog(j.name, await text(`${repoPath}/actions/jobs/${j.id}/logs`))));
      return logs.filter(Boolean).join("\n");
    },
    issueList: async (o) => {
      const raw = await paged<FIssue>(`${repoPath}/issues`, { type: "issues", state: o.state, labels: o.label, q: o.search }, o.limit);
      return raw.filter((i) => !i.pull_request).map((i) => toIssue(i));
    },
    issueView: async (sel) => {
      const n = issueNumber(sel);
      const [issue, comments] = await Promise.all([
        call<FIssue>("GET", `${repoPath}/issues/${n}`),
        call<FComment[] | null>("GET", `${repoPath}/issues/${n}/comments`),
      ]);
      return toIssue(issue, (comments ?? []).map(toComment));
    },
    // Forgejo has no close reason; --reason is accepted and ignored.
    issueClose: async (sel, o) => {
      const n = issueNumber(sel);
      if (o.comment) await comment(n, o.comment);
      await call("PATCH", `${repoPath}/issues/${n}`, { body: { state: "closed" } });
    },
    issueComment: async (sel, body) => comment(issueNumber(sel), body),
    issueLabel: async (sel, add, remove) => relabel(issueNumber(sel), add, remove),
    issueCreate: async (o) => {
      let labels: number[] = [];
      if (o.labels.length) {
        const known = await repoLabels();
        labels = o.labels.map((name) => {
          const found = known.find((l) => l.name === name);
          if (!found) throw new ForgeError(`forge: no label "${name}" in ${slug}; create it with forge label create`);
          return found.id;
        });
      }
      const issue = await call<FIssue>("POST", `${repoPath}/issues`, { body: { title: o.title, body: o.body, labels, assignees: o.assignees } });
      return issue.html_url;
    },
    labelCreate: async (o) => {
      const color = o.color.startsWith("#") ? o.color : `#${o.color}`;
      const existing = (await repoLabels()).find((l) => l.name === o.name);
      if (existing && !o.force) throw new ForgeError(`forge: label "${o.name}" already exists in ${slug}; pass --force to update it`);
      if (existing) await call("PATCH", `${repoPath}/labels/${existing.id}`, { body: { color, ...(o.description ? { description: o.description } : {}) } });
      else await call("POST", `${repoPath}/labels`, { body: { name: o.name, color, description: o.description } });
    },
    repoView: async () => {
      const r = await call<{ name: string; owner: { login: string }; full_name: string; html_url: string; ssh_url: string; clone_url: string; default_branch: string; private: boolean }>("GET", repoPath);
      return {
        forge: "forgejo",
        host: ref.host,
        name: r.name,
        owner: { login: r.owner.login },
        nameWithOwner: r.full_name,
        url: r.html_url,
        sshUrl: r.ssh_url,
        cloneUrl: r.clone_url,
        defaultBranchRef: { name: r.default_branch },
        isPrivate: r.private,
      };
    },
    repoClone: async (dir, gitArgs) => {
      const r = await call<{ ssh_url: string; name: string }>("GET", repoPath);
      const proc = Bun.spawn(["git", "clone", ...gitArgs, r.ssh_url, ...(dir ? [dir] : [])], { cwd, stdio: ["inherit", "inherit", "inherit"] });
      if ((await proc.exited) !== 0) throw new ForgeError(`forge: git clone ${r.ssh_url} failed`);
    },
    api: async (args) => {
      const parsed = parseApiArgs(args, ref);
      const query: Record<string, string> = {};
      let body: string | undefined = parsed.input !== undefined ? readFileSync(parsed.input === "-" ? 0 : parsed.input, "utf8") : undefined;
      const method = parsed.method ?? (Object.keys(parsed.fields).length || body !== undefined ? "POST" : "GET");
      if (method === "GET") for (const [k, v] of Object.entries(parsed.fields)) query[k] = String(v);
      else if (body === undefined && Object.keys(parsed.fields).length) body = JSON.stringify(parsed.fields);
      const pages: unknown[] = [];
      for (let page = 1; ; page++) {
        const q = parsed.paginate ? { ...query, page: String(page), limit: String(PAGE) } : query;
        const res = await request(method, parsed.path, { query: q, raw: body });
        const out = await res.text();
        if (!res.ok) {
          process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
          console.error(`forge: ${method} ${parsed.path}: HTTP ${res.status}`);
          return 1;
        }
        if (!parsed.paginate) {
          await emit(out, parsed.jq);
          return 0;
        }
        const items = out ? (JSON.parse(out) as unknown) : [];
        if (!Array.isArray(items)) {
          await emit(out, parsed.jq);
          return 0;
        }
        pages.push(...items);
        if (items.length < PAGE) break;
      }
      await emit(JSON.stringify(pages), parsed.jq);
      return 0;
    },
  };
};

export interface ApiArgs {
  path: string;
  method?: string;
  fields: Record<string, unknown>;
  input?: string;
  paginate: boolean;
  jq?: string;
}

// gh api's flags: -X/--method, -f/--raw-field k=v (string), -F/--field k=v (true, false,
// null and numbers typed; @file reads a file), --input file, --paginate, -q/--jq. The path is
// relative to /api/v1; {owner} and {repo} are filled in.
export const parseApiArgs = (args: string[], ref: RepoRef): ApiArgs => {
  const out: ApiArgs = { path: "", fields: {}, paginate: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = (): string => {
      const v = args[++i];
      if (v === undefined) throw new ForgeError(`forge api: ${a} needs a value`);
      return v;
    };
    if (a === "-X" || a === "--method") out.method = next().toUpperCase();
    else if (a === "-f" || a === "--raw-field") {
      const [k, ...v] = next().split("=");
      out.fields[k] = v.join("=");
    } else if (a === "-F" || a === "--field") {
      const [k, ...rest] = next().split("=");
      const v = rest.join("=");
      out.fields[k] = v === "true" ? true : v === "false" ? false : v === "null" ? null : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v.startsWith("@") ? readFileSync(v.slice(1), "utf8") : v;
    } else if (a === "--input") out.input = next();
    else if (a === "--paginate") out.paginate = true;
    else if (a === "-q" || a === "--jq") out.jq = next();
    else if (a === "-H" || a === "--header") next();
    else if (a.startsWith("-")) throw new ForgeError(`forge api: unknown flag ${a}`);
    else if (!out.path) out.path = a;
    else throw new ForgeError(`forge api: unexpected argument ${a}`);
  }
  if (!out.path) throw new ForgeError("forge api: missing path");
  out.path = `/${out.path.replace(/^\/+/, "").replace(/^api\/v1\//, "")}`
    .replaceAll("{owner}", ref.owner)
    .replaceAll(":owner", ref.owner)
    .replaceAll("{repo}", ref.name)
    .replaceAll(":repo", ref.name);
  return out;
};
