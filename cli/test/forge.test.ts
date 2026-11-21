// forge: host resolution, the shared rules, and both backends against responses recorded from
// the live forges (Forgejo 16.0.2 on joshgachnang/forgejo-scratch; gh on TerrenoLabs/terreno).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgejoBackend, parseApiArgs } from "../src/forge/forgejo.ts";
import { githubBackend } from "../src/forge/github.ts";
import { parseArgs } from "../src/forge/main.ts";
import { pick } from "../src/forge/output.ts";
import { forgeFor, loadHosts, parseSlug, resolveRepo } from "../src/forge/resolve.ts";
import { approvedAtHead, bucketFor, checksExitCode, checksState, createdMatches, decideReviews, forgejoThreads, type ForgejoReviewComment } from "../src/forge/rules.ts";
import type { RepoRef, Review } from "../src/forge/types.ts";
import { tempRepo } from "./helpers.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "forge");
const fj = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, "forgejo", name), "utf8"));
const ghFixture = (name: string): string => join(FIXTURES, "github", name);
const MAIN = join(import.meta.dir, "..", "src", "forge", "main.ts");

const SCRATCH: RepoRef = { forge: "forgejo", host: "forgejo.nang.io", owner: "joshgachnang", name: "forgejo-scratch" };
const TERRENO: RepoRef = { forge: "github", host: "github.com", owner: "TerrenoLabs", name: "terreno" };
const REPO = "/api/v1/repos/joshgachnang/forgejo-scratch";
const HEAD = "365a6b85e34a7b1d4668bbcc59c483b024f63bc4";

describe("forge: which repo and which forge", () => {
  test("reads owner/name and host from every remote and link form", () => {
    expect(parseSlug("ssh://git@forgejo.nang.io:2222/joshgachnang/pier.git")).toEqual({ host: "forgejo.nang.io", owner: "joshgachnang", name: "pier" });
    expect(parseSlug("git@github.com:joshgachnang/brewery.git")).toEqual({ host: "github.com", owner: "joshgachnang", name: "brewery" });
    expect(parseSlug("https://forgejo.nang.io/joshgachnang/forgejo-scratch.git")).toEqual({ host: "forgejo.nang.io", owner: "joshgachnang", name: "forgejo-scratch" });
    expect(parseSlug("https://forgejo.nang.io/joshgachnang/forgejo-scratch/pulls/1")?.name).toBe("forgejo-scratch");
    expect(parseSlug("https://github.com/TerrenoLabs/terreno/pull/1737")).toEqual({ host: "github.com", owner: "TerrenoLabs", name: "terreno" });
    expect(parseSlug("https://forgejo.nang.io/joshgachnang/forgejo-scratch/actions/runs/7/jobs/0")?.owner).toBe("joshgachnang");
    expect(parseSlug("forgejo.nang.io/joshgachnang/pier")).toEqual({ host: "forgejo.nang.io", owner: "joshgachnang", name: "pier" });
    expect(parseSlug("joshgachnang/pier")).toEqual({ host: null, owner: "joshgachnang", name: "pier" });
    expect(parseSlug("not a repo")).toBeNull();
  });

  test("github.com is GitHub, a listed host is Forgejo, anything else is an error", () => {
    const hosts = { "forgejo.nang.io": { type: "forgejo" as const, url: "https://forgejo.nang.io", token: "t-file" } };
    expect(forgeFor({ host: "github.com", owner: "a", name: "b" }, hosts).ref.forge).toBe("github");
    const fj = forgeFor({ host: "forgejo.nang.io", owner: "a", name: "b" }, hosts, {});
    expect(fj.ref.forge).toBe("forgejo");
    expect(fj.token).toBe("t-file");
    expect(forgeFor({ host: "forgejo.nang.io", owner: "a", name: "b" }, { "forgejo.nang.io": { type: "forgejo", url: "https://x" } }, { FORGEJO_TOKEN: "t-env" }).token).toBe("t-env");
    expect(() => forgeFor({ host: "gitlab.com", owner: "a", name: "b" }, hosts, {})).toThrow(/unknown host gitlab.com/);
  });

  test("hosts.json must say forgejo and give a URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-hosts-"));
    try {
      const path = join(dir, "hosts.json");
      writeFileSync(path, JSON.stringify({ "git.example.com": { type: "gitlab", url: "https://git.example.com" } }));
      expect(() => loadHosts(path)).toThrow(/type must be "forgejo"/);
      writeFileSync(path, JSON.stringify({ "Git.Example.com": { type: "forgejo", url: "https://git.example.com/" } }));
      expect(loadHosts(path)).toEqual({ "git.example.com": { type: "forgejo", url: "https://git.example.com", token: undefined, bots: undefined } });
      expect(loadHosts(join(dir, "missing.json"))).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("-R wins over origin, a bare OWNER/REPO borrows origin's host, and no origin is an error", async () => {
    const repo = tempRepo();
    const dir = mkdtempSync(join(tmpdir(), "forge-hosts-"));
    try {
      const hostsFile = join(dir, "hosts.json");
      writeFileSync(hostsFile, JSON.stringify({ "forgejo.nang.io": { type: "forgejo", url: "https://forgejo.nang.io", token: "t" } }));
      chmodSync(hostsFile, 0o600);
      const env = { FORGE_HOSTS: hostsFile };
      await expect(resolveRepo({ cwd: repo, env })).rejects.toThrow(/no origin remote/);
      await expect(resolveRepo({ repo: "joshgachnang/pier", cwd: repo, env })).rejects.toThrow(/names no host/);
      Bun.spawnSync(["git", "remote", "add", "origin", "ssh://git@forgejo.nang.io:2222/joshgachnang/forgejo-scratch.git"], { cwd: repo });
      expect((await resolveRepo({ cwd: repo, env })).ref).toEqual(SCRATCH);
      expect((await resolveRepo({ repo: "joshgachnang/pier", cwd: repo, env })).ref).toEqual({ ...SCRATCH, name: "pier" });
      expect((await resolveRepo({ repo: "github.com/TerrenoLabs/terreno", cwd: repo, env })).ref).toEqual(TERRENO);
      expect((await resolveRepo({ urlArg: "https://github.com/TerrenoLabs/terreno/pull/1737", cwd: repo, env })).ref).toEqual(TERRENO);
      await expect(resolveRepo({ repo: "https://gitlab.com/a/b", cwd: repo, env })).rejects.toThrow(/unknown host gitlab.com/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("forge: rules shared by both forges", () => {
  test("states map to gh's buckets, and a set of checks to green, red, running or none", () => {
    expect(["success", "warning", "failure", "error", "pending", "SKIPPED", "CANCELLED", "IN_PROGRESS"].map(bucketFor))
      .toEqual(["pass", "pass", "fail", "fail", "pending", "skipping", "cancel", "pending"]);
    expect(checksState([])).toBe("none");
    expect(checksState([{ bucket: "pass" }, { bucket: "skipping" }])).toBe("green");
    expect(checksState([{ bucket: "pass" }, { bucket: "pending" }])).toBe("running");
    expect(checksState([{ bucket: "pending" }, { bucket: "fail" }])).toBe("red");
    expect(checksState([{ bucket: "cancel" }])).toBe("red");
    expect(["green", "red", "running", "none"].map((s) => checksExitCode(s as "green"))).toEqual([0, 1, 8, 1]);
  });

  const review = (login: string, state: Review["state"], at: string): Review =>
    ({ id: at, author: { login, isBot: false }, state, body: "", submittedAt: at, commit: { oid: "" }, stale: false });

  test("approved means each non-author reviewer's newest deciding review approves and none requests changes", () => {
    expect(decideReviews([], "me")).toBe("REVIEW_REQUIRED");
    expect(decideReviews([review("me", "APPROVED", "1")], "me")).toBe("REVIEW_REQUIRED");
    expect(decideReviews([review("bot", "CHANGES_REQUESTED", "1"), review("bot", "APPROVED", "2")], "me")).toBe("APPROVED");
    expect(decideReviews([review("bot", "APPROVED", "1"), review("bot", "COMMENTED", "2")], "me")).toBe("APPROVED");
    expect(decideReviews([review("bot", "APPROVED", "1"), review("ann", "CHANGES_REQUESTED", "2")], "me")).toBe("CHANGES_REQUESTED");
    expect(decideReviews([review("bot", "APPROVED", "2"), review("bot", "CHANGES_REQUESTED", "1")], "me")).toBe("APPROVED");
    expect(decideReviews([review("bot", "DISMISSED", "1"), review("ann", "COMMENTED", "2")], "me")).toBe("REVIEW_REQUIRED");
  });

  test("approvedAtHead needs a deciding approval on the head, and a stale one does not count", () => {
    const at = (login: string, state: Review["state"], when: string, oid: string): Review => ({ ...review(login, state, when), commit: { oid } });
    expect(approvedAtHead([at("bot", "APPROVED", "1", "h2")], "me", "h2", "APPROVED")).toBe(true);
    expect(approvedAtHead([at("bot", "APPROVED", "1", "h1")], "me", "h2", "APPROVED")).toBe(false);
    expect(approvedAtHead([at("bot", "APPROVED", "1", "h2"), at("bot", "COMMENTED", "2", "h3")], "me", "h3", "APPROVED")).toBe(false);
    expect(approvedAtHead([at("bot", "APPROVED", "1", "h2")], "me", "h2", "CHANGES_REQUESTED")).toBe(false);
  });

  test("Forgejo review comments group into threads by file and line", () => {
    const comments = [...(fj("review-1-comments.json") as ForgejoReviewComment[]), ...(fj("review-2-comments.json") as ForgejoReviewComment[])];
    const threads = forgejoThreads(comments, []);
    expect(threads.map((t) => [t.path, t.line, t.comments.map((c) => c.author.login), t.isResolved])).toEqual([
      ["probe.txt", 2, ["brewery-bot", "joshgachnang"], false],
      ["probe.txt", 3, ["brewery-bot"], false],
    ]);
    expect(threads[0].comments[0].author.isBot).toBe(true);
    expect(threads[0].id).toBe("23");
    // The API can read a resolver but cannot set one, so this case is the recorded comment
    // with `resolver` filled in the way Forgejo's model serializes it.
    const resolved = comments.map((c) => (c.id === 24 ? { ...c, resolver: { login: "joshgachnang" } } : c));
    expect(forgejoThreads(resolved, []).map((t) => t.isResolved)).toEqual([false, true]);
  });

  test("--json takes gh's field list, and an unknown field names the ones that exist", () => {
    const parsed = parseArgs(["12", "--json", "number,headRefOid", "-q", ".number", "-R", "o/r"], { json: {}, jq: { alias: "q", value: true } });
    expect(parsed).toEqual({ flags: { jq: ".number", repo: "o/r" }, positional: ["12"], rest: [], fields: ["number", "headRefOid"] });
    expect(parseArgs(["--json"], { json: {} }).fields).toEqual([]);
    expect(() => parseArgs(["--nope"], {})).toThrow(/unknown flag --nope/);
    expect(pick({ a: 1, b: 2 }, ["b"])).toEqual({ b: 2 });
    expect(() => pick({ a: 1 }, ["zz"])).toThrow(/available: a/);
  });

  test("--created reads gh's comparison forms and bare dates", () => {
    expect(createdMatches(">=2026-11-20", "2026-11-21T00:00:00Z")).toBe(true);
    expect(createdMatches(">2026-11-21T00:00:00Z", "2026-11-21T00:00:00Z")).toBe(false);
    expect(createdMatches("<2026-11-20", "2026-11-19T23:59:59Z")).toBe(true);
    expect(createdMatches("2026-11-12", "2026-11-12T19:41:07Z")).toBe(true);
    expect(createdMatches("2026-11-12", "2026-11-13T00:00:00Z")).toBe(false);
  });

  test("forge api fills {owner}/{repo}, types -F fields, and is relative to /api/v1", () => {
    expect(parseApiArgs(["/api/v1/repos/{owner}/{repo}/pulls", "-X", "post", "-f", "title=x", "-F", "draft=true", "-F", "n=3"], SCRATCH)).toEqual({
      path: "/repos/joshgachnang/forgejo-scratch/pulls", method: "POST", fields: { title: "x", draft: true, n: 3 }, paginate: false, headers: {},
    });
    expect(parseApiArgs(["user", "-H", "Accept: text/plain", "-H", "X-Trace:1"], SCRATCH).headers).toEqual({ Accept: "text/plain", "X-Trace": "1" });
    expect(() => parseApiArgs(["user", "-H", "nocolon"], SCRATCH)).toThrow(/Name: value/);
  });
});

// A stand-in Forgejo that answers from the recorded fixtures and logs every request.
interface Hit {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}

const fakeForgejo = (routes: Record<string, (hit: Hit) => Response | unknown>): { url: string; hits: Hit[]; stop: () => void } => {
  const hits: Hit[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const text = req.method === "GET" ? "" : await req.text();
      const hit: Hit = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: text ? JSON.parse(text) : undefined, headers: Object.fromEntries(req.headers) };
      hits.push(hit);
      // A wrong token gets Forgejo 16's real 401 body, which echoes the token back.
      const sent = (req.headers.get("authorization") ?? "").replace(/^token /, "");
      if (sent !== "test-token") return Response.json({ message: `access token does not exist [sha: ${sent}]\ntask with token "${sent}": resource does not exist`, url: "https://forgejo.nang.io/api/swagger" }, { status: 401 });
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return Response.json({ message: "no fixture" }, { status: 404 });
      const out = route(hit);
      if (out instanceof Response) return out;
      return typeof out === "string" ? new Response(out) : Response.json(out);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) };
};

const withStatus = (status: string): unknown => {
  const combined = fj("status-success.json") as { state: string; statuses: { status: string }[] };
  return { ...combined, state: status, statuses: combined.statuses.map((s, i) => (i === 0 ? { ...s, status } : s)) };
};

const scratchRoutes = (overrides: Record<string, (hit: Hit) => Response | unknown> = {}): Record<string, (hit: Hit) => Response | unknown> => ({
  [`GET ${REPO}`]: () => fj("repo.json"),
  [`GET ${REPO}/pulls/1`]: () => fj("pr-open.json"),
  [`GET ${REPO}/pulls`]: () => fj("pulls-open.json"),
  [`GET ${REPO}/pulls/1/reviews`]: () => fj("reviews-approved.json"),
  [`GET ${REPO}/pulls/1/reviews/1/comments`]: () => fj("review-1-comments.json"),
  [`GET ${REPO}/pulls/1/reviews/2/comments`]: () => fj("review-2-comments.json"),
  [`GET ${REPO}/pulls/1/reviews/3/comments`]: () => [],
  [`GET ${REPO}/pulls/1.diff`]: () => readFileSync(join(FIXTURES, "forgejo", "pr-1.diff"), "utf8"),
  [`GET ${REPO}/issues/1/comments`]: () => fj("issue-comments.json"),
  [`GET ${REPO}/commits/${HEAD}/status`]: () => fj("status-success.json"),
  [`GET ${REPO}/actions/runs`]: (hit) => {
    const all = fj("runs-done.json") as { workflow_runs: { index_in_repo: number }[] };
    return hit.query.run_number ? { ...all, workflow_runs: all.workflow_runs.filter((r) => r.index_in_repo === Number(hit.query.run_number)) } : all;
  },
  [`GET ${REPO}/actions/runs/20/jobs`]: () => fj("jobs-done.json"),
  [`GET ${REPO}/actions/jobs/28/logs`]: () => readFileSync(join(FIXTURES, "forgejo", "job-28.log"), "utf8"),
  [`GET ${REPO}/issues`]: () => fj("issues-open.json"),
  [`GET ${REPO}/issues/2`]: () => fj("issue-view.json"),
  [`GET ${REPO}/issues/2/comments`]: () => [],
  [`POST ${REPO}/issues/2/labels`]: () => fj("issue-view.json"),
  [`DELETE ${REPO}/issues/2/labels/triaged`]: () => new Response(null, { status: 204 }),
  [`GET ${REPO}/issues/2/labels`]: () => [{ name: "bug" }],
  [`PATCH ${REPO}/issues/2`]: () => fj("issue-closed.json"),
  [`POST ${REPO}/issues/1/comments`]: () => ({ id: 99, html_url: "https://forgejo.nang.io/joshgachnang/forgejo-scratch/pulls/1#issuecomment-99" }),
  ...overrides,
});

describe("forge: Forgejo backend against recorded responses", () => {
  const backend = (url: string): ReturnType<typeof forgejoBackend> =>
    forgejoBackend(SCRATCH, { entry: { type: "forgejo", url }, token: "test-token", pollMs: 1 });

  test("pr view maps the PR, an approval after a request for changes, and green checks", async () => {
    const server = fakeForgejo(scratchRoutes());
    try {
      const pr = await backend(server.url).prView("https://forgejo.nang.io/joshgachnang/forgejo-scratch/pulls/1");
      expect(pr).toMatchObject({
        forge: "forgejo", number: 1, url: "https://forgejo.nang.io/joshgachnang/forgejo-scratch/pulls/1", state: "OPEN",
        headRefName: "forge-probe", headRefOid: HEAD, baseRefName: "master", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED", checksState: "green", author: { login: "joshgachnang", isBot: false },
      });
      expect(pr.reviews.map((r) => [r.author.login, r.state])).toEqual([["brewery-bot", "DISMISSED"], ["joshgachnang", "COMMENTED"], ["brewery-bot", "APPROVED"]]);
      expect(pr.reviews[0].author.isBot).toBe(true);
      expect(pr.checks).toHaveLength(5);
      expect(pr.checks[0]).toMatchObject({ name: "secrets-test / check (push)", bucket: "pass", workflow: "secrets-test", event: "push" });
      expect(pr.checks[0].link).toBe(`${server.url}/joshgachnang/forgejo-scratch/actions/runs/8/jobs/0`);
      expect(pr.comments.map((c) => c.body)).toEqual(["a plain conversation comment"]);
    } finally {
      server.stop();
    }
  });

  test("a token Forgejo echoes in a 401 never reaches an error message", async () => {
    const canary = "canary0123456789abcdef";
    const server = fakeForgejo(scratchRoutes());
    try {
      const error = await forgejoBackend(SCRATCH, { entry: { type: "forgejo", url: server.url }, token: canary }).prView("1").catch((e: Error) => e);
      expect(String((error as Error).message)).toContain("HTTP 401");
      expect(String((error as Error).message)).toContain("[REDACTED]");
      expect(String((error as Error).message)).not.toContain(canary);
    } finally {
      server.stop();
    }
  });

  test("a network failure is a forge: error", async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response("") });
    const url = `http://127.0.0.1:${closed.port}`;
    closed.stop(true);
    await expect(backend(url).prView("1")).rejects.toThrow(/^forge: GET \/api\/v1\/repos\/joshgachnang\/forgejo-scratch\/pulls\/1: /);
  });

  test("issue comments are read in one call, since Forgejo ignores page and limit there", async () => {
    const server = fakeForgejo(scratchRoutes());
    try {
      await backend(server.url).prView("1");
      const reads = server.hits.filter((h) => h.path === `${REPO}/issues/1/comments`);
      expect(reads).toHaveLength(1);
      expect(reads[0].query).toEqual({});
    } finally {
      server.stop();
    }
  });

  test("approvedAtHead holds only while a deciding approval is on the current head", async () => {
    const moved = { ...(fj("pr-open.json") as { head: object }), head: { ...(fj("pr-open.json") as { head: object }).head, sha: "0".repeat(40) } };
    for (const [pr, want] of [[fj("pr-open.json"), true], [moved, false]] as const) {
      const server = fakeForgejo(scratchRoutes({ [`GET ${REPO}/pulls/1`]: () => pr, [`GET ${REPO}/commits/${"0".repeat(40)}/status`]: () => fj("status-success.json") }));
      try {
        const view = await backend(server.url).prView("1");
        expect([view.reviewDecision, view.approvedAtHead]).toEqual(["APPROVED", want]);
      } finally {
        server.stop();
      }
    }
  });

  test("checks read running while statuses are pending, red on a failure, none with no statuses", async () => {
    for (const [fixture, want] of [[fj("status-pending.json"), "running"], [withStatus("failure"), "red"], [withStatus("error"), "red"], [fj("status-none.json"), "none"]] as const) {
      const server = fakeForgejo(scratchRoutes({ [`GET ${REPO}/commits/${HEAD}/status`]: () => fixture }));
      try {
        expect(checksState(await backend(server.url).prChecks("1"))).toBe(want);
      } finally {
        server.stop();
      }
    }
  });

  test("a PR whose mergeable stays false reads as conflicting after a few re-reads", async () => {
    const pr = { ...(fj("pr-open.json") as object), mergeable: false };
    const server = fakeForgejo(scratchRoutes({ [`GET ${REPO}/pulls/1`]: () => pr }));
    try {
      const view = await backend(server.url).prView("1");
      expect([view.mergeable, view.mergeStateStatus]).toEqual(["CONFLICTING", "DIRTY"]);
      expect(server.hits.filter((h) => h.path === `${REPO}/pulls/1`)).toHaveLength(4);
    } finally {
      server.stop();
    }
  });

  test("a branch selector finds its open PR", async () => {
    const server = fakeForgejo(scratchRoutes());
    try {
      expect((await backend(server.url).prView("forge-probe")).number).toBe(1);
      expect(server.hits.find((h) => h.path === `${REPO}/pulls`)?.query).toMatchObject({ state: "open", head: "forge-probe" });
      await expect(backend(server.url).prView("no-such-branch")).rejects.toThrow(/no open pull request for branch no-such-branch/);
    } finally {
      server.stop();
    }
  });

  test("merge --match-head refuses a moved head before calling merge, and sends head_commit_id otherwise", async () => {
    const server = fakeForgejo(scratchRoutes({ [`POST ${REPO}/pulls/1/merge`]: () => new Response(null, { status: 200 }) }));
    try {
      await expect(backend(server.url).prMerge("1", { method: "squash", matchHead: "c597ac94de09e0396fe9e0507062aaf346ca32bf", deleteBranch: false }))
        .rejects.toThrow(`head is ${HEAD}, not c597ac94de09e0396fe9e0507062aaf346ca32bf`);
      expect(server.hits.some((h) => h.method === "POST")).toBe(false);
      await backend(server.url).prMerge("1", { method: "squash", matchHead: HEAD, deleteBranch: true });
      expect(server.hits.find((h) => h.method === "POST")?.body).toEqual({ Do: "squash", head_commit_id: HEAD, delete_branch_after_merge: true });
    } finally {
      server.stop();
    }
  });

  test("merge maps Forgejo's 409 'head out of date' (a push between the check and the merge) to a refusal", async () => {
    const server = fakeForgejo(scratchRoutes({ [`POST ${REPO}/pulls/1/merge`]: () => Response.json(fj("merge-stale.json"), { status: 409 }) }));
    try {
      await expect(backend(server.url).prMerge("1", { method: "merge", matchHead: HEAD, deleteBranch: false })).rejects.toThrow(/head moved past .*head out of date/);
    } finally {
      server.stop();
    }
  });

  test("threads come from every review's comments", async () => {
    const server = fakeForgejo(scratchRoutes());
    try {
      const threads = await backend(server.url).prThreads("1");
      expect(threads.map((t) => [t.line, t.comments.length])).toEqual([[2, 2], [3, 1]]);
      // Review 3 has no comments, so it is never fetched.
      expect(server.hits.some((h) => h.path.endsWith("/reviews/3/comments"))).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("runs are addressed by run number, which the API resolves to its global id", async () => {
    const server = fakeForgejo(scratchRoutes());
    try {
      const run = await backend(server.url).runView("https://forgejo.nang.io/joshgachnang/forgejo-scratch/actions/runs/7");
      expect(run).toMatchObject({ databaseId: 7, number: 7, workflowName: "runner-test.yml", headBranch: "forge-probe", status: "completed", conclusion: "success" });
      expect(run.jobs.map((j) => [j.databaseId, j.name, j.url.endsWith(`/runs/7/jobs/${run.jobs.indexOf(j)}`)])).toEqual([
        [28, "linux", true], [29, "download", true], [30, "macos", true], [31, "macos-download", true],
      ]);
      expect(server.hits.find((h) => h.path === `${REPO}/actions/runs`)?.query.run_number).toBe("7");
      await expect(backend(server.url).runView("99")).rejects.toThrow(/no run 99/);
      expect((await backend(server.url).runList({ limit: 5, branch: "forge-probe" })).map((r) => r.number)).toEqual([8, 7]);
      expect(server.hits.findLast((h) => h.path === `${REPO}/actions/runs`)?.query.ref).toBe("refs/heads/forge-probe");
    } finally {
      server.stop();
    }
  });

  test("failed-job logs come out in gh's --log-failed shape, and rerun is refused with the run's link", async () => {
    const jobs = (fj("jobs-done.json") as { name: string; status: string }[]).map((j) => (j.name === "linux" ? { ...j, status: "failure" } : j));
    const server = fakeForgejo(scratchRoutes({ [`GET ${REPO}/actions/runs/20/jobs`]: () => jobs }));
    try {
      const log = await backend(server.url).runLogs("7", { failed: true });
      expect(log.split("\n")[3]).toBe("linux\tUNKNOWN STEP\t2026-11-21T00:35:31.2000000Z error: expected 2, received 3");
      expect(server.hits.filter((h) => h.path.includes("/actions/jobs/"))).toHaveLength(1);
      await expect(backend(server.url).runRerun("7", { failed: true })).rejects.toThrow(/no API to rerun.*actions\/runs\/7/);
    } finally {
      server.stop();
    }
  });

  test("issues: list skips PRs, label adds by name and removes by name, close patches the state", async () => {
    const server = fakeForgejo(scratchRoutes());
    try {
      const b = backend(server.url);
      expect((await b.issueList({ state: "open", limit: 10, label: "bug" })).map((i) => [i.number, i.labels.map((l) => l.name)])).toEqual([[2, ["bug"]]]);
      expect(server.hits.find((h) => h.path === `${REPO}/issues`)?.query).toMatchObject({ type: "issues", state: "open", labels: "bug" });
      expect(await b.issueLabel("2", ["bug"], ["triaged"])).toEqual(["bug"]);
      expect(server.hits.find((h) => h.method === "POST")?.body).toEqual({ labels: ["bug"] });
      await b.issueClose("https://forgejo.nang.io/joshgachnang/forgejo-scratch/issues/2", { reason: "not planned" });
      expect(server.hits.find((h) => h.method === "PATCH")?.body).toEqual({ state: "closed" });
      expect(await b.prComment("1", "hi")).toEndWith("/pulls/1#issuecomment-99");
    } finally {
      server.stop();
    }
  });

  test("a merged PR whose branch was deleted keeps its branch name", async () => {
    const server = fakeForgejo(scratchRoutes({
      [`GET ${REPO}/pulls/3`]: () => fj("pr-merged.json"),
      [`GET ${REPO}/pulls/3/reviews`]: () => [],
      [`GET ${REPO}/issues/3/comments`]: () => [],
      [`GET ${REPO}/commits/9dcc45f6391d1124e8ba42761d0581014bd2d200/status`]: () => fj("status-none.json"),
    }));
    try {
      expect(await backend(server.url).prView("3")).toMatchObject({ state: "MERGED", headRefName: "forge-it-20261121005313", mergeable: "UNKNOWN", mergedAt: "2026-11-21T00:54:10Z" });
    } finally {
      server.stop();
    }
  });

  test("pr ready drops Forgejo's WIP prefix, and --undo puts it back", async () => {
    const server = fakeForgejo(scratchRoutes({
      [`GET ${REPO}/pulls/1`]: () => fj("pr-edit-wip.json"),
      [`PATCH ${REPO}/pulls/1`]: () => fj("pr-open.json"),
    }));
    try {
      await backend(server.url).prReady("1", false);
      expect(server.hits.find((h) => h.method === "PATCH")?.body).toEqual({ title: "Probe forge PR shapes" });
      await backend(server.url).prReady("1", true);
      // Already a draft: nothing to change.
      expect(server.hits.filter((h) => h.method === "PATCH")).toHaveLength(1);
    } finally {
      server.stop();
    }
    const ready = fakeForgejo(scratchRoutes({ [`PATCH ${REPO}/pulls/1`]: () => fj("pr-edit-wip.json") }));
    try {
      await backend(ready.url).prReady("1", true);
      expect(ready.hits.find((h) => h.method === "PATCH")?.body).toEqual({ title: "WIP: Probe forge PR shapes" });
    } finally {
      ready.stop();
    }
  });

  test("pr edit patches title and body (keeping a draft's prefix), requests and drops reviewers, and relabels by name", async () => {
    const server = fakeForgejo(scratchRoutes({
      [`GET ${REPO}/pulls/1`]: () => fj("pr-edit-wip.json"),
      [`PATCH ${REPO}/pulls/1`]: () => fj("pr-edit-wip.json"),
      [`POST ${REPO}/pulls/1/requested_reviewers`]: () => fj("requested-reviewers.json"),
      [`DELETE ${REPO}/pulls/1/requested_reviewers`]: () => new Response(null, { status: 204 }),
      [`POST ${REPO}/issues/1/labels`]: () => [{ name: "bug" }],
      [`DELETE ${REPO}/issues/1/labels/triaged`]: () => new Response(null, { status: 204 }),
      [`GET ${REPO}/issues/1/labels`]: () => [{ name: "bug" }],
    }));
    try {
      await backend(server.url).prEdit("1", { title: "New title", body: "new body", addReviewers: ["brewery-bot"], removeReviewers: ["old-bot"], addLabels: ["bug"], removeLabels: ["triaged"] });
      const writes = server.hits.filter((h) => h.method !== "GET").map((h) => [h.method, h.path.replace(REPO, ""), h.body]);
      expect(writes).toEqual([
        ["PATCH", "/pulls/1", { title: "WIP: New title", body: "new body" }],
        ["POST", "/pulls/1/requested_reviewers", { reviewers: ["brewery-bot"] }],
        ["DELETE", "/pulls/1/requested_reviewers", { reviewers: ["old-bot"] }],
        ["POST", "/issues/1/labels", { labels: ["bug"] }],
        ["DELETE", "/issues/1/labels/triaged", undefined],
      ]);
    } finally {
      server.stop();
    }
  });

  test("pr review posts the verdict on the head, and a comment or change request needs a body", async () => {
    const server = fakeForgejo(scratchRoutes({ [`POST ${REPO}/pulls/1/reviews`]: () => fj("review-rc.json") }));
    try {
      expect(await backend(server.url).prReview("1", "approve", "")).toContain("/pulls/1");
      expect(server.hits.find((h) => h.method === "POST")?.body).toEqual({ event: "APPROVED", body: "", commit_id: HEAD });
      await expect(backend(server.url).prReview("1", "request-changes", "")).rejects.toThrow(/--request-changes needs --body/);
    } finally {
      server.stop();
    }
  });

  test("issue create sends label ids for label names, and an unknown label is an error", async () => {
    const server = fakeForgejo(scratchRoutes({
      [`GET ${REPO}/labels`]: () => fj("labels.json"),
      [`POST ${REPO}/issues`]: () => fj("issue-create.json"),
    }));
    try {
      expect(await backend(server.url).issueCreate({ title: "t", body: "b", labels: ["bug"], assignees: [] })).toBe("https://forgejo.nang.io/joshgachnang/forgejo-scratch/issues/4");
      expect(server.hits.find((h) => h.method === "POST")?.body).toEqual({ title: "t", body: "b", labels: [32], assignees: [] });
      await expect(backend(server.url).issueCreate({ title: "t", body: "b", labels: ["nope"], assignees: [] })).rejects.toThrow(/no label "nope"/);
    } finally {
      server.stop();
    }
  });

  test("label create adds a new label, refuses an existing one, and updates it with --force", async () => {
    const server = fakeForgejo(scratchRoutes({
      [`GET ${REPO}/labels`]: () => fj("labels.json"),
      [`POST ${REPO}/labels`]: () => fj("label-create.json"),
      [`PATCH ${REPO}/labels/34`]: () => fj("label-create.json"),
    }));
    try {
      const b = backend(server.url);
      await b.labelCreate({ name: "fresh", color: "123456", description: "d", force: false });
      expect(server.hits.find((h) => h.method === "POST")?.body).toEqual({ name: "fresh", color: "#123456", description: "d" });
      await expect(b.labelCreate({ name: "forge-probe-label", color: "654321", description: "", force: false })).rejects.toThrow(/already exists/);
      await b.labelCreate({ name: "forge-probe-label", color: "#654321", description: "", force: true });
      expect(server.hits.find((h) => h.method === "PATCH")?.body).toEqual({ color: "#654321" });
    } finally {
      server.stop();
    }
  });

  test("run list --created filters by creation time, since Forgejo's API cannot", async () => {
    const runs = fj("runs-done.json") as { workflow_runs: { created: string }[] };
    const dated = { ...runs, workflow_runs: [{ ...runs.workflow_runs[0], created: "2026-11-21T00:35:26Z" }, { ...runs.workflow_runs[1], created: "2026-11-12T19:41:07Z" }] };
    const server = fakeForgejo(scratchRoutes({ [`GET ${REPO}/actions/runs`]: () => dated }));
    try {
      expect((await backend(server.url).runList({ limit: 5, created: ">=2026-11-20" })).map((r) => r.number)).toEqual([8]);
      expect((await backend(server.url).runList({ limit: 5, created: "2026-11-12" })).map((r) => r.number)).toEqual([7]);
    } finally {
      server.stop();
    }
  });

  test("pr list --state merged keeps only merged PRs, and --author @me is the token's user", async () => {
    const open = fj("pulls-open.json") as { merged: boolean }[];
    const server = fakeForgejo(scratchRoutes({
      [`GET ${REPO}/pulls`]: () => [...open, { ...open[0], number: 9, state: "closed", merged: true }],
      ["GET /api/v1/user"]: () => ({ login: "joshgachnang" }),
    }));
    try {
      expect((await backend(server.url).prList({ state: "merged", limit: 5, author: "@me" })).map((p) => [p.number, p.state])).toEqual([[9, "MERGED"]]);
      expect(server.hits.find((h) => h.path === `${REPO}/pulls`)?.query).toMatchObject({ state: "closed", poster: "joshgachnang" });
    } finally {
      server.stop();
    }
  });
});

// A stand-in gh that prints recorded output for the argv it is given and logs every call.
const fakeGh = (dir: string, routes: { match: string[]; file?: string; out?: string; code?: number }[]): string => {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, "routes.json"), JSON.stringify(routes));
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, "calls.jsonl"))}, JSON.stringify(argv) + "\\n");
const routes = JSON.parse(readFileSync(${JSON.stringify(join(dir, "routes.json"))}, "utf8"));
const route = routes.find((r) => r.match.every((m, i) => argv[i] === m));
if (!route) { console.error("fake gh: no route for " + argv.join(" ")); process.exit(2); }
process.stdout.write(route.file ? readFileSync(route.file, "utf8") : (route.out ?? ""));
process.exit(route.code ?? 0);
`);
  chmodSync(join(bin, "gh"), 0o755);
  return join(bin, "gh");
};

const calls = (dir: string): string[][] => readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("forge: GitHub backend through gh, against recorded gh output", () => {
  let dir: string;
  let gh: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "forge-gh-"));
    gh = fakeGh(dir, [
      { match: ["pr", "view", "1737"], file: ghFixture("pr-view.json") },
      { match: ["pr", "checks", "1737"], file: ghFixture("pr-checks.json"), code: 1 },
      { match: ["api", "graphql"], file: ghFixture("pr-threads.json") },
      { match: ["run", "list"], file: ghFixture("run-list.json") },
      { match: ["run", "view"], file: ghFixture("run-view.json") },
      { match: ["issue", "view"], file: ghFixture("issue-view.json") },
      { match: ["repo", "view"], file: ghFixture("repo-view.json") },
      { match: ["pr", "merge"], out: "" },
      { match: ["pr", "create"], out: "Creating pull request\nhttps://github.com/TerrenoLabs/terreno/pull/1800" },
      { match: ["pr", "edit"], out: "https://github.com/TerrenoLabs/terreno/pull/1737" },
      { match: ["pr", "ready"], out: "" },
      { match: ["pr", "review"], out: "" },
      { match: ["issue", "create"], out: "Creating issue\nhttps://github.com/TerrenoLabs/terreno/issues/1900" },
      { match: ["label", "create"], out: "" },
    ]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("pr view maps gh's JSON onto the shared schema, with checks from gh pr checks", async () => {
    const pr = await githubBackend(TERRENO, { gh }).prView("https://github.com/TerrenoLabs/terreno/pull/1737");
    expect(pr).toMatchObject({ forge: "github", repo: "TerrenoLabs/terreno", number: 1737, url: "https://github.com/TerrenoLabs/terreno/pull/1737", state: "OPEN", mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED" });
    expect(pr.headRefOid).toMatch(/^[0-9a-f]{40}$/);
    expect(pr.checks).toHaveLength(44);
    expect(pr.checksState).toBe("red");
    expect(pr.checks.filter((c) => c.bucket === "skipping").map((c) => c.state)).toEqual(["SKIPPED", "SKIPPED"]);
    expect(pr.reviews.find((r) => r.author.login === "cursor")?.state).toBe("COMMENTED");
    expect(calls(dir).find((c) => c[1] === "view")).toEqual(["pr", "view", "1737", "-R", "TerrenoLabs/terreno", "--json", expect.stringContaining("headRefOid")]);
  });

  test("with no PR given, gh is handed the current branch (gh refuses -R without one)", async () => {
    const repo = tempRepo();
    try {
      Bun.spawnSync(["git", "checkout", "-q", "-b", "my-feature"], { cwd: repo });
      const routes = join(dir, "routes.json");
      const saved = readFileSync(routes, "utf8");
      writeFileSync(routes, JSON.stringify([...JSON.parse(saved), { match: ["pr", "view", "my-feature"], file: ghFixture("pr-view.json") }, { match: ["pr", "checks", "my-feature"], file: ghFixture("pr-checks.json"), code: 1 }]));
      try {
        expect((await githubBackend(TERRENO, { gh, cwd: repo }).prView(undefined)).number).toBe(1737);
      } finally {
        writeFileSync(routes, saved);
      }
      expect(calls(dir).filter((c) => c[2] === "my-feature").map((c) => c.slice(0, 3).join(" ")).sort()).toEqual(["pr checks my-feature", "pr view my-feature"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("pr edit, ready and review, issue create, label create and run list --created map to gh's own flags", async () => {
    const b = githubBackend(TERRENO, { gh });
    await b.prEdit("1737", { title: "T", body: "B", addReviewers: ["a", "b"], removeReviewers: ["c"], addLabels: ["bug"], removeLabels: ["old"] });
    const edit = calls(dir).find((c) => c[1] === "edit") as string[];
    expect(edit.slice(0, edit.indexOf("--body-file"))).toEqual(["pr", "edit", "1737", "-R", "TerrenoLabs/terreno", "--title", "T", "--add-reviewer", "a,b", "--remove-reviewer", "c", "--add-label", "bug", "--remove-label", "old"]);
    await b.prReady("1737", true);
    expect(calls(dir).find((c) => c[1] === "ready")).toEqual(["pr", "ready", "1737", "-R", "TerrenoLabs/terreno", "--undo"]);
    await b.prReview("1737", "approve", "");
    expect(calls(dir).find((c) => c[1] === "review")).toEqual(["pr", "review", "1737", "-R", "TerrenoLabs/terreno", "--approve"]);
    expect(await b.issueCreate({ title: "Flaky", body: "x", labels: ["bug", "ci"], assignees: [] })).toBe("https://github.com/TerrenoLabs/terreno/issues/1900");
    const create = calls(dir).find((c) => c[0] === "issue" && c[1] === "create") as string[];
    expect(create.filter((a, i) => a === "--label" || create[i - 1] === "--label")).toEqual(["--label", "bug", "--label", "ci"]);
    await b.labelCreate({ name: "flaky", color: "#ff0000", description: "Flaky test", force: true });
    expect(calls(dir).find((c) => c[0] === "label")).toEqual(["label", "create", "flaky", "-R", "TerrenoLabs/terreno", "--color", "ff0000", "--description", "Flaky test", "--force"]);
    await b.runList({ limit: 3, status: "failure", created: ">=2026-11-01" });
    expect(calls(dir).findLast((c) => c[0] === "run" && c[1] === "list")?.slice(-4)).toEqual(["--status", "failure", "--created", ">=2026-11-01"]);
  });

  test("threads keep GitHub's resolved and outdated flags", async () => {
    const threads = await githubBackend(TERRENO, { gh }).prThreads("1737");
    expect(threads.map((t) => t.isResolved)).toEqual([false, false, false, true, true]);
    expect(threads[3].comments[0].author).toEqual({ login: "github-advanced-security", isBot: true });
    expect(threads[0]).toMatchObject({ path: "example-backend/Dockerfile", line: 12 });
  });

  test("runs, issues and repos map, and merge passes --match-head-commit through", async () => {
    const b = githubBackend(TERRENO, { gh });
    const runs = await b.runList({ limit: 3, branch: "master" });
    expect(runs).toHaveLength(3);
    expect(runs[0].url).toContain("/actions/runs/");
    const run = await b.runView("https://github.com/TerrenoLabs/terreno/actions/runs/123");
    expect(run).toMatchObject({ status: "completed", conclusion: "success" });
    expect(run.jobs[0].name).toBe("Zero findings");
    expect(calls(dir).find((c) => c[0] === "run" && c[1] === "view")?.slice(0, 3)).toEqual(["run", "view", "123"]);
    expect((await b.issueView("1")).forge).toBe("github");
    expect(await b.repoView()).toMatchObject({ nameWithOwner: "TerrenoLabs/terreno", defaultBranchRef: { name: "master" } });
    await b.prMerge("1737", { method: "squash", matchHead: "abc123", deleteBranch: true });
    expect(calls(dir).find((c) => c[1] === "merge")).toEqual(["pr", "merge", "1737", "-R", "TerrenoLabs/terreno", "--squash", "--match-head-commit", "abc123", "--delete-branch"]);
    expect(await b.prCreate({ title: "t", body: "b", head: "x", draft: false })).toBe("https://github.com/TerrenoLabs/terreno/pull/1800");
  });
});

describe("forge: the command line", () => {
  let repo: string;
  let dir: string;
  let server: ReturnType<typeof fakeForgejo>;
  let env: Record<string, string>;
  beforeAll(() => {
    repo = tempRepo();
    dir = mkdtempSync(join(tmpdir(), "forge-cli-"));
    server = fakeForgejo(scratchRoutes({ [`GET ${REPO}/commits/${HEAD}/status`]: () => fj("status-pending.json") }));
    const hostsFile = join(dir, "hosts.json");
    writeFileSync(hostsFile, JSON.stringify({ "forgejo.nang.io": { type: "forgejo", url: server.url, token: "test-token" } }));
    chmodSync(hostsFile, 0o600);
    fakeGh(dir, [{ match: ["pr", "view", "1737"], file: ghFixture("pr-view.json") }, { match: ["pr", "checks", "1737"], file: ghFixture("pr-checks.json"), code: 1 }]);
    env = { ...(process.env as Record<string, string>), FORGE_HOSTS: hostsFile, PATH: `${join(dir, "bin")}:${process.env.PATH}`, FORGE_POLL_MS: "1" };
    Bun.spawnSync(["git", "remote", "add", "origin", "ssh://git@forgejo.nang.io:2222/joshgachnang/forgejo-scratch.git"], { cwd: repo });
  });
  afterAll(() => {
    server.stop();
    rmSync(repo, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  // Async, so the fake Forgejo in this process can answer while the child waits on it.
  const forge = async (...args: string[]): Promise<{ code: number; out: string; err: string }> => {
    const proc = Bun.spawn([process.execPath, MAIN, ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, out, err };
  };

  test("picks Forgejo from origin and prints selected fields through jq", async () => {
    expect(await forge("pr", "view", "1", "--json", "number,url,reviewDecision")).toMatchObject({ code: 0 });
    expect(JSON.parse((await forge("pr", "view", "1", "--json", "number,url,reviewDecision")).out)).toEqual({
      number: 1, url: "https://forgejo.nang.io/joshgachnang/forgejo-scratch/pulls/1", reviewDecision: "APPROVED",
    });
    expect((await forge("pr", "view", "1", "--json", "headRefOid", "-q", ".headRefOid")).out.trim()).toBe(HEAD);
  });

  test("pr view --comments prints the conversation and the reviews that said something", async () => {
    const res = await forge("pr", "view", "1", "--comments");
    expect(res.code).toBe(0);
    expect(res.out).toContain("--- joshgachnang commented");
    expect(res.out).toContain("a plain conversation comment");
    expect(res.out).toContain("--- brewery-bot reviewed: APPROVED");
  });

  test("pr view and forge api never print the token a 401 echoes, and forge api passes -H through", async () => {
    const canary = "canary0123456789abcdef";
    const hostsFile = join(dir, "hosts-canary.json");
    writeFileSync(hostsFile, JSON.stringify({ "forgejo.nang.io": { type: "forgejo", url: server.url, token: canary } }));
    chmodSync(hostsFile, 0o600);
    const saved = env.FORGE_HOSTS;
    env.FORGE_HOSTS = hostsFile;
    try {
      for (const args of [["pr", "view", "1"], ["api", "repos/{owner}/{repo}"]]) {
        const res = await forge(...args);
        expect(res.code).toBe(1);
        expect(`${res.out}${res.err}`).toContain("[REDACTED]");
        expect(`${res.out}${res.err}`).not.toContain(canary);
      }
    } finally {
      env.FORGE_HOSTS = saved;
    }
    const ok = await forge("api", "repos/{owner}/{repo}", "-H", "X-Forge-Test: yes", "-q", ".full_name");
    expect(ok.out.trim()).toBe("joshgachnang/forgejo-scratch");
    expect(server.hits.findLast((h) => h.path === REPO)?.headers["x-forge-test"]).toBe("yes");
  });

  test("pr checks exits 8 while checks run, like gh", async () => {
    const res = await forge("pr", "checks", "1", "--json", "name,bucket");
    expect(res.code).toBe(8);
    expect(JSON.parse(res.out).map((c: { bucket: string }) => c.bucket)).toContain("pending");
  });

  test("-R to github.com runs gh, and one schema comes back", async () => {
    const res = await forge("pr", "view", "1737", "-R", "github.com/TerrenoLabs/terreno", "--json", "forge,number,checksState");
    expect(JSON.parse(res.out)).toEqual({ forge: "github", number: 1737, checksState: "red" });
  });

  test("an unknown host or command is an error, never a guess", async () => {
    const res = await forge("pr", "view", "1", "-R", "https://gitlab.com/a/b");
    expect(res.code).toBe(1);
    expect(res.err).toContain("unknown host gitlab.com");
    expect((await forge("pr", "frob")).err).toContain('unknown command "pr frob"');
  });
});
