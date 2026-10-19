import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApproveContext } from "../src/approve/context.ts";
import { splitBody } from "../src/approve/context.ts";
import { mergeJudges, NO_PLAN, runJudge } from "../src/approve/judge.ts";
import { validateJudge, validateVerdict } from "../src/approve/schemas.ts";
import { newState, runDir } from "../src/state.ts";
import type { PrView } from "../src/vcs.ts";
import { fakeSetup, quietCtx, tempRepo } from "./helpers.ts";

const SENTINEL = "BODY-SENTINEL-do-not-show-the-judge";

const view: PrView = {
  number: 9,
  title: "Cloud Run service",
  body: `## Why\n${SENTINEL}\n\n## What changed\n- things (T2)\n`,
  author: "dev",
  authorIsBot: false,
  isDraft: false,
  labels: [],
  base: "master",
  headSha: "abc",
  reviews: [],
  checks: [],
  botThreads: [],
};

const context = (plans: ApproveContext["plans"]): ApproveContext => ({
  pr: view,
  files: [{ path: "src/service.ts", additions: 3, deletions: 0 }],
  diff: "diff --git a/src/service.ts b/src/service.ts\n+export const service = 1;\n",
  body: splitBody(view.body),
  scope: ["T2"],
  plans,
  policy: { approve: { approveLevels: ["low"], rubric: "", planDirs: [], skipAuthors: [], skipLabels: [], maxLines: 1, maxFiles: 1, budgetUsd: 1, pathRules: [] }, rubric: null, source: "master@x" },
  evidence: { media: [], testFiles: [] },
});

const plan = { path: "docs/plans/x.md", text: "# Plan X\n\n- [ ] **T2** — Cloud Run service\n", editedInPr: false };

const report = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: "aligned",
  missing: [],
  unrequested: [],
  planEdited: false,
  evidenceGaps: [],
  summary: "T2 delivered.",
  ...over,
});

describe("plan judge", () => {
  test("the judge's prompt holds the plan, the scope, and the diff, and never the PR body", async () => {
    const dir = tempRepo();
    const { config } = fakeSetup(dir, [{ match: "approve (plan judge)", structured: report() }]);
    const state = newState({ slug: "approve-9", repo: dir, ip: "", base: "master", phase: "build" });
    const ctx = quietCtx(state, config);
    const outcomes = await runJudge(ctx, context([plan]), 2);
    expect(outcomes).toEqual([{ agent: "alpha", report: report() as never }]);
    const steps = join(runDir(dir, "approve-9"), "steps");
    const promptFile = readdirSync(steps).find((f) => f.endsWith(".prompt.md")) as string;
    const prompt = readFileSync(join(steps, promptFile), "utf8");
    expect(prompt).toContain("# Plan X");
    expect(prompt).toContain("Scope claimed: T2");
    expect(prompt).toContain("+export const service = 1;");
    expect(prompt).not.toContain(SENTINEL);
    expect(prompt).toContain("read-only step");
  });

  test("a plan changed in the PR is flagged even when the model says otherwise", async () => {
    const dir = tempRepo();
    const { config } = fakeSetup(dir, [{ match: "approve (plan judge)", structured: report({ planEdited: false }) }]);
    const ctx = quietCtx(newState({ slug: "approve-10", repo: dir, ip: "", base: "master", phase: "build" }), config);
    const [outcome] = await runJudge(ctx, context([{ ...plan, editedInPr: true }]));
    expect(outcome.report?.planEdited).toBe(true);
  });

  test("no plan means no agent runs and a no_plan report", async () => {
    const dir = tempRepo();
    const { planPath, config } = fakeSetup(dir, []);
    const ctx = quietCtx(newState({ slug: "approve-11", repo: dir, ip: "", base: "master", phase: "build" }), config);
    expect(await runJudge(ctx, context([]))).toEqual([{ agent: "none", report: NO_PLAN }]);
    expect(() => readFileSync(`${planPath}.calls.log`)).toThrow();
  });

  test("an answer that fails validation becomes an error for that agent", async () => {
    const dir = tempRepo();
    const { config } = fakeSetup(dir, [{ match: "approve (plan judge)", structured: report({ status: "maybe" }) }]);
    const ctx = quietCtx(newState({ slug: "approve-12", repo: dir, ip: "", base: "master", phase: "build" }), config);
    const [outcome] = await runJudge(ctx, context([plan]));
    expect(outcome.report).toBeUndefined();
    expect(outcome.error).toContain('judge status "maybe"');
  });

  test("fan-out runs every agent and merges drift, lists, and planEdited", async () => {
    const dir = tempRepo();
    const { config } = fakeSetup(
      dir,
      [
        { match: "approve (plan judge)", agent: "alpha", structured: report({ missing: ["T2 acceptance: preview no-op"] }) },
        { match: "approve (plan judge)", agent: "beta", structured: report({ status: "drift", unrequested: ["renamed service.ts"], evidenceGaps: ["no test"] }) },
      ],
      { approve: ["alpha", "beta"] },
    );
    const ctx = quietCtx(newState({ slug: "approve-13", repo: dir, ip: "", base: "master", phase: "build" }), config);
    const outcomes = await runJudge(ctx, context([plan]));
    expect(outcomes.map((o) => o.agent)).toEqual(["alpha", "beta"]);
    expect(mergeJudges(outcomes)).toEqual({
      status: "drift",
      missing: ["T2 acceptance: preview no-op"],
      unrequested: ["renamed service.ts"],
      planEdited: false,
      evidenceGaps: ["no test"],
      summary: "T2 delivered. T2 delivered.",
    });
  });

  test("merging ignores errored agents and returns null when none reported", () => {
    expect(mergeJudges([{ agent: "a", error: "x" }])).toBeNull();
    expect(mergeJudges([{ agent: "a", error: "x" }, { agent: "b", report: NO_PLAN }])).toEqual(NO_PLAN);
  });
});

describe("schema validators", () => {
  test("judge reports need the enum status, string lists, and a boolean", () => {
    expect(validateJudge(report())).toEqual(report() as never);
    expect(validateJudge(report({ missing: "T2" }))).toContain("missing");
    expect(validateJudge(report({ planEdited: "no" }))).toContain("planEdited");
    expect(validateJudge(null)).toContain("not an object");
  });

  test("verdicts need a level, four scored dimensions, typed findings, and a rationale", () => {
    const dim = { score: 2, reasons: ["ok"] };
    const good = { level: "low", dimensions: { ipMatch: dim, architecture: dim, tests: dim, evidence: dim }, findings: [{ severity: "nit", where: "a.ts:1", attack: "x", evidence: "y" }], rationale: "fine" };
    expect(validateVerdict(good)).toEqual(good as never);
    expect(validateVerdict({ ...good, level: "critical" })).toContain("level");
    expect(validateVerdict({ ...good, dimensions: { ...good.dimensions, tests: { score: 4, reasons: [] } } })).toContain("tests score");
    expect(validateVerdict({ ...good, findings: [{ severity: "fatal", where: "", attack: "", evidence: "" }] })).toContain("severity");
    expect(validateVerdict({ ...good, dimensions: { ipMatch: dim } })).toContain("architecture missing");
  });
});
