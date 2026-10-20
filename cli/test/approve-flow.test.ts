import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkRun, markerSha, renderBody } from "../src/approve/render.ts";
import { approve, gitReaders, skipReason, waitForOtherChecks, type ApproveDeps, type Poster } from "../src/commands/approve.ts";
import { newState, runDir } from "../src/state.ts";
import type { ChangedFile, PrView } from "../src/vcs.ts";
import { fakeSetup, quietCtx, run, tempRepo } from "./helpers.ts";

const PLAN = "# Plan\n\n- [ ] **T1** — Tidy docs\n";
const view = (over: Partial<PrView> = {}): PrView => ({
  number: 12,
  title: "Tidy the docs",
  body: "## Why\nReaders got lost. Plan: `docs/plans/tidy.md` (T1).\n\n## What changed\n- Reordered docs/approve.md\n\n## Verification\n| Status | Scope | Evidence |\n| --- | --- | --- |\n| ✅ Tested | Links | `bun test docs` → ok |\n",
  author: "dev",
  authorIsBot: false,
  isDraft: false,
  labels: [],
  base: "master",
  headSha: "abcdef1234567",
  reviews: [],
  checks: [{ name: "test", bucket: "pass" }],
  botThreads: [],
  ...over,
});

const judge = { status: "aligned", missing: [], unrequested: [], planEdited: false, evidenceGaps: [], summary: "T1 delivered." };
const dim = (score: number, ...reasons: string[]): { score: number; reasons: string[] } => ({ score, reasons });
const verdict = (level: string, findings: unknown[] = []): Record<string, unknown> => ({
  level,
  dimensions: { ipMatch: dim(3, "T1 delivered; nothing beyond the plan"), architecture: dim(3, "docs only"), tests: dim(2, "no test needed"), evidence: dim(3, "CI green") },
  findings,
  rationale: `A ${level}-risk docs change.`,
});

const recorder = (): Poster & { calls: { kind: string; event?: string; reason?: string; body: string }[] } => {
  const calls: { kind: string; event?: string; reason?: string; body: string }[] = [];
  return {
    calls,
    appLogin: "terreno-approve[bot]",
    post: async ({ verdict: v, body }) => {
      calls.push({ kind: "post", event: v.approve ? "APPROVE" : "COMMENT", body });
    },
    skip: async ({ reason, body }) => {
      calls.push({ kind: "skip", reason, body });
    },
  };
};

const deps = (pr: PrView, files: ChangedFile[], poster?: Poster): ApproveDeps => ({
  ci: {
    prView: async () => pr,
    prFiles: async () => files,
    prDiff: async () => "diff --git a/docs/approve.md b/docs/approve.md\n+# Approve\n",
  },
  readBase: async (path) => (path === ".brewery.json" ? '{"approve": {"approveLevels": ["low"]}}' : null),
  readHead: async (path) => (path === "docs/plans/tidy.md" ? PLAN : null),
  baseSha: async () => "base123",
  poster,
});

const docs: ChangedFile[] = [{ path: "docs/approve.md", additions: 10, deletions: 2 }];
const auth: ChangedFile[] = [{ path: "src/auth/session.ts", additions: 4, deletions: 1 }];

const setup = (slug: string, plan: unknown[]): ReturnType<typeof quietCtx> & { dir: string } => {
  const dir = tempRepo();
  const { config } = fakeSetup(dir, plan);
  const ctx = quietCtx(newState({ slug, repo: dir, ip: "", base: "master", phase: "build" }), config);
  return Object.assign(ctx, { dir });
};

describe("brewery approve", () => {
  test("a low-risk docs PR with a matching plan is approved and the review says why", async () => {
    const ctx = setup("approve-12", [
      { match: "approve (plan judge)", structured: judge },
      { match: "approve (rubric)", structured: verdict("low") },
    ]);
    const poster = recorder();
    const out = await approve(ctx, deps(view(), docs, poster), 12, { dryRun: false });
    expect(out.skipped).toBeNull();
    expect(out.verdict?.approve).toBe(true);
    expect(out.posted).toBe(true);
    expect(poster.calls).toEqual([{ kind: "post", event: "APPROVE", body: out.body }]);
    expect(out.body.startsWith("<!-- terreno-approve:abcdef1234567 -->\n**Risk: low — approved.** T1 delivered; nothing beyond the plan\n")).toBe(true);
    expect(out.body).toContain("#### Plan match 3/3\n\nT1 delivered. Nothing beyond the plan.\n");
    expect(out.body).not.toContain("| Dimension |");
    expect(out.body).toContain("#### Tests 2/3\n\nno test needed.\n");
    expect(out.body).toContain("Plan: aligned — T1 delivered.");
    expect(out.body).toContain("Checks: pass (1) · Bot threads: 0 unresolved · Human changes requested: no · Size: ok");
    expect(out.body).toContain("Floor: none · Ceiling: low · Categories: docs");
    expect(out.body).toContain("Policy: `.brewery.json` at `master@base123`, rubric brewery default, agents alpha");
    expect(markerSha(out.body)).toBe("abcdef1234567");
    expect(checkRun(out.verdict!)).toEqual({ conclusion: "success", title: "Risk: low — approved", summary: "A low-risk docs change." });
    expect(ctx.lines.some((l) => l.includes("verdict: low, approve"))).toBe(true);
  });

  test("an auth change the model called low is raised to high, commented, and the check is neutral", async () => {
    const ctx = setup("approve-13", [
      { match: "approve (plan judge)", structured: judge },
      { match: "approve (rubric)", structured: verdict("low") },
    ]);
    const poster = recorder();
    const out = await approve(ctx, deps(view(), auth, poster), 12, { dryRun: false });
    expect(out.verdict?.level).toBe("high");
    expect(out.verdict?.approve).toBe(false);
    expect(poster.calls[0].event).toBe("COMMENT");
    expect(out.body).toContain("**Risk: high — not approved.** risk high is above the configured approval levels (low)");
    expect(out.body).toContain("Floor: high · Ceiling: none · Categories: auth · Model said low");
    expect(checkRun(out.verdict!).conclusion).toBe("neutral");
  });

  test("a blocking finding makes the check fail", async () => {
    const ctx = setup("approve-14", [
      { match: "approve (plan judge)", structured: judge },
      { match: "approve (rubric)", structured: verdict("low", [{ severity: "blocking", where: "docs/approve.md:4", attack: "pastes a live token", evidence: "ghp_abc" }]) },
    ]);
    const out = await approve(ctx, deps(view(), docs, recorder()), 12, { dryRun: false });
    expect(out.verdict?.approve).toBe(false);
    expect(out.body).toContain("- **blocking** `docs/approve.md:4` — pastes a live token · ghp_abc");
    expect(checkRun(out.verdict!).conclusion).toBe("failure");
  });

  test("--dry-run runs the agents but posts nothing", async () => {
    const ctx = setup("approve-15", [
      { match: "approve (plan judge)", structured: judge },
      { match: "approve (rubric)", structured: verdict("low") },
    ]);
    const poster = recorder();
    const out = await approve(ctx, deps(view(), docs, poster), 12, { dryRun: true });
    expect(out.verdict?.approve).toBe(true);
    expect(out.posted).toBe(false);
    expect(poster.calls).toEqual([]);
    expect(existsSync(join(runDir(ctx.dir, "approve-15"), "steps"))).toBe(true);
  });

  test("a skip posts no verdict, runs no agent, and still tells the poster", async () => {
    const ctx = setup("approve-16", []);
    const poster = recorder();
    const out = await approve(ctx, deps(view({ isDraft: true }), docs, poster), 12, { dryRun: false });
    expect(out.skipped).toBe("draft pull request");
    expect(out.verdict).toBeNull();
    expect(out.body).toBe("<!-- terreno-approve:abcdef1234567 -->\n**Skipped.** draft pull request\n");
    expect(poster.calls).toEqual([{ kind: "skip", reason: "draft pull request", body: out.body }]);
    expect(existsSync(join(runDir(ctx.dir, "approve-16"), "steps"))).toBe(false);
  });

  test("posting without a poster is an error, not a silent dry run", async () => {
    const ctx = setup("approve-17", [
      { match: "approve (plan judge)", structured: judge },
      { match: "approve (rubric)", structured: verdict("low") },
    ]);
    await expect(approve(ctx, deps(view(), docs), 12, { dryRun: false })).rejects.toThrow("no poster configured");
  });
});

describe("skipReason", () => {
  const base = (pr: PrView): Parameters<typeof skipReason>[0] =>
    ({ pr, policy: { approve: { skipLabels: ["hold"], skipAuthors: ["dependabot[bot]"] } } }) as never;

  test("drafts, labels, authors, the App itself, human change requests, and an existing approval at this head", () => {
    expect(skipReason(base(view()), "terreno-approve[bot]")).toBeNull();
    expect(skipReason(base(view({ labels: ["hold"] })), undefined)).toBe('label "hold"');
    expect(skipReason(base(view({ author: "dependabot[bot]" })), undefined)).toBe("author dependabot[bot] is skipped by policy");
    expect(skipReason(base(view({ author: "terreno-approve", authorIsBot: true })), "terreno-approve[bot]")).toBe("the approver cannot review its own pull request");
    expect(skipReason(base(view({ reviews: [{ id: "1", author: "kim", state: "CHANGES_REQUESTED", body: "", isBot: false }] })), undefined)).toBe("kim requested changes");
    const approved = view({ reviews: [{ id: "2", author: "terreno-approve", state: "APPROVED", body: "<!-- terreno-approve:abcdef1234567 -->\nok", isBot: true }] });
    expect(skipReason(base(approved), "terreno-approve[bot]")).toBe("already approved at abcdef1");
    const stale = view({ reviews: [{ id: "2", author: "terreno-approve", state: "APPROVED", body: "<!-- terreno-approve:0000000 -->\nok", isBot: true }] });
    expect(skipReason(base(stale), "terreno-approve[bot]")).toBeNull();
  });
});

describe("gitReaders", () => {
  test("reads policy from the base ref and plans from the head commit", async () => {
    const dir = tempRepo();
    run(dir, "git", "checkout", "-q", "-b", "feature");
    await Bun.write(join(dir, "docs", "plans", "x.md"), "# X at head\n");
    await Bun.write(join(dir, ".brewery.json"), '{"approve": {"approveLevels": ["high"]}}');
    run(dir, "git", "add", "-A");
    run(dir, "git", "commit", "-q", "-m", "head");
    const head = run(dir, "git", "rev-parse", "HEAD");
    const readers = gitReaders(dir, "master", head);
    expect(await readers.readBase(".brewery.json")).toBeNull();
    expect(await readers.readHead("docs/plans/x.md")).toBe("# X at head\n");
    expect(await readers.readHead("missing.md")).toBeNull();
    expect(await readers.baseSha()).toBe(run(dir, "git", "rev-parse", "--short", "master"));
  });
});

describe("renderBody", () => {
  test("a not-approved verdict with several reasons lists the rest after the first line", () => {
    const ctx = { pr: view({ checks: [] }), policy: { source: "master@1", rubric: "x", approve: { rubric: "docs/r.md" } } } as never;
    const body = renderBody(
      {
        level: "medium",
        approve: false,
        reasons: ["risk medium is above the configured approval levels (low)", "2 unresolved bot review threads"],
        dimensions: { ipMatch: dim(2, "a"), architecture: dim(2), tests: dim(1, "b"), evidence: dim(2) } as never,
        findings: [],
        rationale: "Fine but not low.",
        classification: { categories: ["source"], floor: null, ceiling: null, never: [] },
        gates: { checks: "pass", botThreads: 2, humanChangesRequested: false, size: "ok" },
        judge: null,
        agents: ["claude"],
        errors: [{ agent: "codex", error: "no structured output" }],
        modelLevel: "medium",
      },
      ctx,
    );
    expect(body).toContain("**Risk: medium — not approved.** risk medium is above the configured approval levels (low)\n\nAlso: 2 unresolved bot review threads.\n");
    expect(body).toContain("#### Architecture 2/3\n\n—\n");
    expect(body).toContain("Plan: none referenced.");
    expect(body).toContain("rubric `docs/r.md`, agents claude, failed: codex (no structured output)");
  });
});

describe("brewery approve: CI gate", () => {
  test("a failing check skips the head before any model runs", async () => {
    const ctx = setup("approve-gate-red", []);
    const poster = recorder();
    const red = view({ checks: [{ name: "test", bucket: "fail" }, { name: "lint", bucket: "pass" }, { name: "ci/circleci: approve", bucket: "pending" }] });
    const out = await approve(ctx, deps(red, docs, poster), 12, { dryRun: false });
    expect(out.skipped).toBe("checks failing on this head: test");
    expect(poster.calls).toEqual([{ kind: "skip", reason: "checks failing on this head: test", body: out.body }]);
    expect(existsSync(join(runDir(ctx.dir, "approve-gate-red"), "steps"))).toBe(false);
  });

  test("with checks required, a pending check skips; the approver's own job and check run never count", async () => {
    const ctx = setup("approve-gate-pending", [
      { match: "approve (plan judge)", structured: judge },
      { match: "approve (rubric)", structured: verdict("low") },
    ]);
    const own = [{ name: "ci/circleci: approve", bucket: "pending" as const }, { name: "terreno/approve", bucket: "pending" as const }];
    const pending = view({ checks: [{ name: "test", bucket: "pending" }, ...own] });
    expect(skipReason(await contextOf(pending), undefined, { requireChecks: true })).toBe("checks still pending on this head: test");
    expect(skipReason(await contextOf(pending), undefined)).toBeNull();
    const out = await approve(ctx, deps(view({ checks: [{ name: "test", bucket: "pass" }, ...own] }), docs, recorder()), 12, { dryRun: false, requireChecks: true });
    expect(out.skipped).toBeNull();
    expect(out.verdict?.approve).toBe(true);
    expect(out.verdict?.gates.checks).toBe("pass");
  });

  test("waitForOtherChecks polls until the other checks finish and ignores the approver's own", async () => {
    const views = [
      view({ checks: [{ name: "test", bucket: "pending" }, { name: "ci/circleci: approve", bucket: "pending" }] }),
      view({ checks: [{ name: "test", bucket: "pending" }, { name: "ci/circleci: approve", bucket: "pending" }] }),
      view({ checks: [{ name: "test", bucket: "pass" }, { name: "ci/circleci: approve", bucket: "pending" }] }),
    ];
    let i = 0;
    const slept: number[] = [];
    const ci = { prView: async () => views[Math.min(i++, views.length - 1)] };
    const waited = await waitForOtherChecks(ci, "/repo", 12, { selfChecks: ["ci/circleci: approve"] }, { minutes: 5, intervalMs: 7, sleep: async (ms) => { slept.push(ms); } });
    expect(slept).toEqual([7, 7]);
    expect(waited.headChanged).toBe(false);
    expect(waited.view.checks[0].bucket).toBe("pass");
  });

  test("waitForOtherChecks stops when the head moves, and at the deadline", async () => {
    const moved = [view({ checks: [{ name: "test", bucket: "pending" }] }), view({ headSha: "fedcba9876543", checks: [{ name: "test", bucket: "pending" }] })];
    let i = 0;
    const ci = { prView: async () => moved[Math.min(i++, moved.length - 1)] };
    const out = await waitForOtherChecks(ci, "/repo", 12, { selfChecks: [] }, { minutes: 5, intervalMs: 1, sleep: async () => {} });
    expect(out.headChanged).toBe(true);
    let j = 0;
    const stuck = { prView: async () => { j++; return view({ checks: [{ name: "test", bucket: "pending" }] }); } };
    const late = await waitForOtherChecks(stuck, "/repo", 12, { selfChecks: [] }, { minutes: 0, intervalMs: 1, sleep: async () => {} });
    expect(late.headChanged).toBe(false);
    expect(j).toBe(1);
  });
});

const contextOf = async (pr: PrView): Promise<Parameters<typeof skipReason>[0]> => {
  const { gatherContext } = await import("../src/approve/context.ts");
  const d = deps(pr, docs);
  return gatherContext({ ci: d.ci, repo: "/repo", pr: pr.number, view: pr, readBase: d.readBase, readHead: d.readHead, baseSha: d.baseSha });
};
