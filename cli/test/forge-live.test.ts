// forge against the real Forgejo: opens a PR on joshgachnang/forgejo-scratch, waits for its
// Actions checks, reads review threads, refuses a merge at a moved head, and merges at the
// real one. Needs the tailnet, SSH access to forgejo.nang.io:2222, and a hosts.json entry
// whose token belongs to an admin (the reviews are posted as brewery-bot with Sudo).
//   FORGE_LIVE=1 bun test test/forge-live.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostsPath, loadHosts } from "../src/forge/resolve.ts";

const MAIN = join(import.meta.dir, "..", "src", "forge", "main.ts");
const HOST = "forgejo.nang.io";
const SLUG = "joshgachnang/forgejo-scratch";
const REVIEWER = "brewery-bot";

const run = async (cwd: string, argv: string[]): Promise<{ code: number; out: string; err: string }> => {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out.trim(), err: err.trim() };
};

const step = (line: string): void => console.log(`[forge-live] ${line}`);

test.skipIf(!process.env.FORGE_LIVE)("a PR on Forgejo goes from open through checks and threads to a merge at its head", async () => {
  const entry = loadHosts(hostsPath())[HOST];
  expect(entry?.token).toBeTruthy();
  const api = async (method: string, path: string, body?: unknown, sudo?: string): Promise<unknown> => {
    const res = await fetch(`${entry.url}/api/v1/repos/${SLUG}${path}`, {
      method,
      headers: { Authorization: `token ${entry.token}`, "Content-Type": "application/json", ...(sudo ? { Sudo: sudo } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };

  const dir = mkdtempSync(join(tmpdir(), "forge-live-"));
  const repo = join(dir, "scratch");
  const forge = async (...args: string[]): Promise<{ code: number; out: string; err: string }> => {
    const res = await run(repo, [process.execPath, MAIN, ...args]);
    step(`forge ${args.join(" ")} -> exit ${res.code}${res.err ? ` (${res.err.split("\n").at(-1)})` : ""}`);
    return res;
  };
  const git = async (...args: string[]): Promise<string> => {
    const res = await run(repo, ["git", ...args]);
    if (res.code !== 0) throw new Error(`git ${args.join(" ")}: ${res.err}`);
    return res.out;
  };

  try {
    const clone = await run(dir, ["git", "clone", "-q", `ssh://git@${HOST}:2222/${SLUG}.git`, repo]);
    expect(clone.code).toBe(0);
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const branch = `forge-it-${stamp}`;
    await git("checkout", "-q", "-b", branch);
    writeFileSync(join(repo, `forge-it-${stamp}.txt`), "first line\nsecond line\nthird line\n");
    await git("add", "-A");
    await git("-c", "user.name=forge-live", "-c", "user.email=forge-live@example.invalid", "commit", "-q", "-m", `forge integration ${stamp}`);
    await git("push", "-q", "origin", branch);
    const first = await git("rev-parse", "HEAD");
    step(`pushed ${branch} at ${first}`);

    const created = await forge("pr", "create", "--title", `forge integration ${stamp}`, "--body", "Opened by cli/test/forge-live.test.ts", "--base", "master");
    expect(created.code).toBe(0);
    expect(created.out).toMatch(new RegExp(`^${entry.url}/${SLUG}/pulls/\\d+$`));
    const number = created.out.split("/").at(-1) as string;
    step(`opened ${created.out}`);

    const watched = await forge("pr", "checks", number, "--watch", "--interval", "10", "--grace", "180");
    step(`checks:\n${watched.out}`);
    expect(watched.code).toBe(0);
    const view = JSON.parse((await forge("pr", "view", number, "--json", "number,url,state,headRefOid,checksState,reviewDecision,mergeable")).out);
    step(`view: ${JSON.stringify(view)}`);
    expect(view).toMatchObject({ number: Number(number), state: "OPEN", headRefOid: first, checksState: "green", reviewDecision: "REVIEW_REQUIRED" });

    const runs = JSON.parse((await forge("run", "list", "--commit", first, "--json", "databaseId,workflowName,status,conclusion,url")).out);
    step(`runs: ${JSON.stringify(runs)}`);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r: { status: string; conclusion: string }) => r.status === "completed" && r.conclusion === "success")).toBe(true);
    const ranRun = JSON.parse((await forge("run", "view", String(runs[0].databaseId), "--json", "number,jobs")).out);
    expect(ranRun.jobs.length).toBeGreaterThan(0);
    const logs = await forge("run", "logs", String(runs[0].databaseId), "--job", String(ranRun.jobs[0].databaseId));
    expect(logs.out.split("\n")[0]).toStartWith(`${ranRun.jobs[0].name}\tUNKNOWN STEP\t`);

    await api("POST", `/pulls/${number}/reviews`, {
      event: "REQUEST_CHANGES", body: "One thing", commit_id: first,
      comments: [{ path: `forge-it-${stamp}.txt`, new_position: 2, body: "second line needs a look" }],
    }, REVIEWER);
    await api("POST", `/pulls/${number}/reviews`, {
      event: "COMMENT", body: "", commit_id: first,
      comments: [{ path: `forge-it-${stamp}.txt`, new_position: 2, body: "Fixed in the next commit" }],
    });
    const threads = JSON.parse((await forge("pr", "threads", number, "--json")).out);
    step(`threads: ${JSON.stringify(threads.map((t: { path: string; line: number; isResolved: boolean; comments: { author: { login: string } }[] }) => ({ path: t.path, line: t.line, isResolved: t.isResolved, by: t.comments.map((c) => c.author.login) })))}`);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ line: 2, isResolved: false });
    expect(threads[0].comments.map((c: { author: { login: string; isBot: boolean } }) => [c.author.login, c.author.isBot])).toEqual([[REVIEWER, true], ["joshgachnang", false]]);
    expect(JSON.parse((await forge("pr", "view", number, "--json", "reviewDecision,approvedAtHead")).out)).toEqual({ reviewDecision: "CHANGES_REQUESTED", approvedAtHead: false });

    // Move the head, approve it, then try to merge at the old head.
    writeFileSync(join(repo, `forge-it-${stamp}.txt`), "first line\nsecond line, fixed\nthird line\n");
    await git("-c", "user.name=forge-live", "-c", "user.email=forge-live@example.invalid", "commit", "-qam", "Fix the second line");
    await git("push", "-q", "origin", branch);
    const second = await git("rev-parse", "HEAD");
    await api("POST", `/pulls/${number}/reviews`, { event: "APPROVED", body: "Looks good", commit_id: second }, REVIEWER);
    const approved = JSON.parse((await forge("pr", "view", number, "--json", "headRefOid,reviewDecision,approvedAtHead")).out);
    step(`after push and approval: ${JSON.stringify(approved)}`);
    expect(approved).toEqual({ headRefOid: second, reviewDecision: "APPROVED", approvedAtHead: true });

    const stale = await forge("pr", "merge", number, "--merge", "--match-head-commit", first);
    expect(stale.code).toBe(1);
    expect(stale.err).toContain(`not ${first}`);
    expect(JSON.parse((await forge("pr", "view", number, "--json", "state")).out).state).toBe("OPEN");

    // The server-side guard too: Forgejo's own merge call with the old head is refused.
    const direct = await fetch(`${entry.url}/api/v1/repos/${SLUG}/pulls/${number}/merge`, {
      method: "POST",
      headers: { Authorization: `token ${entry.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ Do: "merge", head_commit_id: first }),
    });
    step(`direct merge at the old head -> HTTP ${direct.status} ${(await direct.text()).trim()}`);
    expect(direct.status).toBe(409);

    const merged = await forge("pr", "merge", number, "--merge", "--match-head-commit", second, "--delete-branch");
    expect(merged.code).toBe(0);
    const after = JSON.parse((await forge("pr", "view", number, "--json", "state,mergedAt")).out);
    step(`after merge: ${JSON.stringify(after)}`);
    expect(after.state).toBe("MERGED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 25 * 60_000);
