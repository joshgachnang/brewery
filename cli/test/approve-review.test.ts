import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApproveContext } from "../src/approve/context.ts";
import { splitBody } from "../src/approve/context.ts";
import { NO_PLAN } from "../src/approve/judge.ts";
import { classify } from "../src/approve/policy.ts";
import { DEFAULT_RUBRIC, gatesFor, mergeVerdict, runRubric, type RubricOutcome } from "../src/approve/review.ts";
import type { JudgeReport, ModelVerdict } from "../src/approve/schemas.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { newState, runDir } from "../src/state.ts";
import type { ChangedFile, PrView } from "../src/vcs.ts";
import { fakeSetup, quietCtx, tempRepo } from "./helpers.ts";

const view = (over: Partial<PrView> = {}): PrView => ({
  number: 5,
  title: "Tidy the docs",
  body: "## Why\nReaders got lost.\n\n## What changed\n- Reordered docs/approve.md\n\n## Verification\n| Status | Scope | Evidence |\n| --- | --- | --- |\n| ✅ Tested | Links | `bun test docs` → ok |\n",
  author: "dev",
  authorIsBot: false,
  isDraft: false,
  labels: [],
  base: "master",
  headSha: "abc",
  reviews: [],
  checks: [{ name: "test", bucket: "pass" }],
  botThreads: [],
  ...over,
});

const context = (files: ChangedFile[], over: Partial<ApproveContext> = {}, pr: Partial<PrView> = {}): ApproveContext => {
  const p = view(pr);
  return {
    pr: p,
    files,
    diff: "diff --git a/docs/approve.md b/docs/approve.md\n+# Approve\n",
    body: splitBody(p.body),
    scope: [],
    plans: [],
    policy: { approve: { ...DEFAULT_CONFIG.approve }, rubric: null, source: "master@abc" },
    evidence: { media: [], testFiles: [] },
    ...over,
  };
};

const dim = (score: 0 | 1 | 2 | 3, ...reasons: string[]): ModelVerdict["dimensions"]["tests"] => ({ score, reasons });
const verdict = (level: ModelVerdict["level"], over: Partial<ModelVerdict> = {}): ModelVerdict => ({
  level,
  dimensions: { ipMatch: dim(3, "no plan; body matches"), architecture: dim(3), tests: dim(2, "docs only"), evidence: dim(3, "CI green") },
  findings: [],
  rationale: `Looks ${level}.`,
  ...over,
});
const outcome = (agent: string, v: ModelVerdict): RubricOutcome => ({ agent, verdict: v });

const docsOnly: ChangedFile[] = [{ path: "docs/approve.md", additions: 10, deletions: 2 }];
const authFile: ChangedFile[] = [{ path: "src/auth/session.ts", additions: 4, deletions: 1 }];

describe("gatesFor", () => {
  test("clean checks, no threads, no human change request, small diff", () => {
    expect(gatesFor(context(docsOnly), DEFAULT_CONFIG.approve)).toEqual({ checks: "pass", botThreads: 0, humanChangesRequested: false, size: "ok" });
  });
  test("a failing or pending check is reported, ignoring the approver's own check", () => {
    const failing = context(docsOnly, {}, { checks: [{ name: "test", bucket: "fail" }, { name: "brewery/approve", bucket: "pending" }] });
    expect(gatesFor(failing, DEFAULT_CONFIG.approve).checks).toBe("fail");
    const pending = context(docsOnly, {}, { checks: [{ name: "lint", bucket: "pending" }] });
    expect(gatesFor(pending, DEFAULT_CONFIG.approve).checks).toBe("pending");
    const onlyOwn = context(docsOnly, {}, { checks: [{ name: "brewery/approve", bucket: "pending" }] });
    expect(gatesFor(onlyOwn, DEFAULT_CONFIG.approve).checks).toBe("pass");
  });
  test("a human's latest review decides changes-requested; bots and superseded reviews do not", () => {
    const superseded = context(docsOnly, {}, {
      reviews: [
        { id: "1", author: "kim", state: "CHANGES_REQUESTED", body: "", isBot: false },
        { id: "2", author: "kim", state: "APPROVED", body: "", isBot: false },
        { id: "3", author: "cursor", state: "CHANGES_REQUESTED", body: "", isBot: true },
      ],
    });
    expect(gatesFor(superseded, DEFAULT_CONFIG.approve).humanChangesRequested).toBe(false);
    const open = context(docsOnly, {}, { reviews: [{ id: "1", author: "kim", state: "CHANGES_REQUESTED", body: "", isBot: false }] });
    expect(gatesFor(open, DEFAULT_CONFIG.approve).humanChangesRequested).toBe(true);
  });
  test("size is over when lines or files exceed the limits", () => {
    expect(gatesFor(context([{ path: "a.ts", additions: 801, deletions: 0 }]), DEFAULT_CONFIG.approve).size).toBe("over");
    const many = Array.from({ length: 41 }, (_, i) => ({ path: `f${i}.ts`, additions: 1, deletions: 0 }));
    expect(gatesFor(context(many), DEFAULT_CONFIG.approve).size).toBe("over");
    expect(gatesFor(context(docsOnly), { ...DEFAULT_CONFIG.approve, maxLines: 11 }).size).toBe("over");
  });
});

describe("mergeVerdict", () => {
  test("a docs-only low verdict with clean gates approves", () => {
    const v = mergeVerdict({ context: context(docsOnly), outcomes: [outcome("claude", verdict("low"))], judge: NO_PLAN });
    expect(v.level).toBe("low");
    expect(v.approve).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.classification.ceiling).toBe("low");
    expect(v.agents).toEqual(["claude"]);
    expect(v.rationale).toBe("Looks low.");
  });

  test("the model cannot go below a floor: low on an auth file becomes high", () => {
    const v = mergeVerdict({ context: context(authFile), outcomes: [outcome("claude", verdict("low"))], judge: NO_PLAN });
    expect(v.modelLevel).toBe("low");
    expect(v.level).toBe("high");
    expect(v.approve).toBe(false);
    expect(v.reasons).toEqual(["risk high is above the configured approval levels (low)"]);
  });

  test("the ceiling caps the model: medium on docs only becomes low", () => {
    const v = mergeVerdict({ context: context(docsOnly), outcomes: [outcome("claude", verdict("medium"))], judge: NO_PLAN });
    expect(v.level).toBe("low");
    expect(v.approve).toBe(true);
  });

  test("fan-out takes the strictest level, the lowest scores, and unions findings", () => {
    const a = verdict("low", { findings: [{ severity: "nit", where: "docs/approve.md:3", attack: "typo", evidence: "teh" }] });
    const b = verdict("medium", {
      dimensions: { ipMatch: dim(3), architecture: dim(1, "mixed concerns"), tests: dim(2), evidence: dim(2, "no screenshot") },
      findings: [
        { severity: "nit", where: "docs/approve.md:3", attack: "typo", evidence: "teh" },
        { severity: "should-fix", where: "docs/approve.md:9", attack: "dead link", evidence: "404" },
      ],
    });
    const v = mergeVerdict({ context: context([{ path: "src/x.ts", additions: 2, deletions: 0 }]), outcomes: [outcome("claude", a), outcome("codex", b)], judge: NO_PLAN });
    expect(v.level).toBe("medium");
    expect(v.approve).toBe(false);
    expect(v.dimensions.architecture).toEqual({ score: 1, reasons: ["mixed concerns"] });
    expect(v.dimensions.evidence).toEqual({ score: 2, reasons: ["CI green", "no screenshot"] });
    expect(v.findings.map((f) => [f.severity, f.where, f.agents])).toEqual([
      ["should-fix", "docs/approve.md:9", ["codex"]],
      ["nit", "docs/approve.md:3", ["claude", "codex"]],
    ]);
    expect(v.rationale).toBe("claude: Looks low.\n\ncodex: Looks medium.");
  });

  test("a blocking finding blocks approval at low", () => {
    const v = mergeVerdict({
      context: context(docsOnly),
      outcomes: [outcome("claude", verdict("low", { findings: [{ severity: "blocking", where: "docs/approve.md:1", attack: "leaks a token", evidence: "ghp_" }] }))],
      judge: NO_PLAN,
    });
    expect(v.approve).toBe(false);
    expect(v.reasons).toEqual(["1 blocking finding"]);
  });

  test("a plan edited in the PR is never low", () => {
    const judge: JudgeReport = { ...NO_PLAN, status: "aligned", planEdited: true, summary: "aligned after editing the plan" };
    const v = mergeVerdict({ context: context(docsOnly), outcomes: [outcome("claude", verdict("low"))], judge });
    expect(v.level).toBe("medium");
    expect(v.classification.floor).toBe("medium");
    expect(v.approve).toBe(false);
  });

  test("failed gates and never-files are all named", () => {
    const ctx = context([{ path: ".brewery.json", additions: 1, deletions: 0 }, ...docsOnly], {}, {
      checks: [{ name: "test", bucket: "fail" }],
      botThreads: [{ id: "t", author: "cursor[bot]", body: "bug" }],
    });
    const v = mergeVerdict({ context: ctx, outcomes: [outcome("claude", verdict("low"))], judge: NO_PLAN });
    expect(v.approve).toBe(false);
    expect(v.reasons).toEqual(["checks on this head are failing", "1 unresolved bot review thread", "policy files changed: .brewery.json"]);
  });

  test("no usable verdict means high and not approved, naming the agents' errors", () => {
    const v = mergeVerdict({ context: context(docsOnly), outcomes: [{ agent: "claude", error: 'verdict level "critical" is not low/medium/high' }], judge: NO_PLAN });
    expect(v.level).toBe("high");
    expect(v.approve).toBe(false);
    expect(v.reasons[0]).toBe('no agent produced a verdict (claude: verdict level "critical" is not low/medium/high)');
    expect(v.modelLevel).toBeNull();
    expect(v.dimensions.tests).toEqual({ score: 0, reasons: [] });
  });

  test("an empty approveLevels is comment-only even for a clean low", () => {
    const ctx = context(docsOnly);
    ctx.policy.approve = { ...ctx.policy.approve, approveLevels: [] };
    const v = mergeVerdict({ context: ctx, outcomes: [outcome("claude", verdict("low"))], judge: NO_PLAN });
    expect(v.approve).toBe(false);
    expect(v.reasons[0]).toContain("approveLevels is empty");
  });
});

describe("runRubric", () => {
  test("two fake agents run, the strictest wins, and an invalid score is rejected", async () => {
    const dir = tempRepo();
    const { config } = fakeSetup(
      dir,
      [
        { match: "approve (rubric)", agent: "alpha", structured: verdict("low") },
        { match: "approve (rubric)", agent: "beta", structured: verdict("medium") },
      ],
      { approve: ["alpha", "beta"] },
    );
    const state = newState({ slug: "approve-5", repo: dir, ip: "", base: "master", phase: "build" });
    const ctx = quietCtx(state, config);
    const c = context([{ path: "src/x.ts", additions: 2, deletions: 0 }]);
    const classification = classify(["src/x.ts"], DEFAULT_CONFIG.approve.pathRules);
    const outcomes = await runRubric(ctx, c, classification, NO_PLAN, 1);
    expect(outcomes.map((o) => [o.agent, o.verdict?.level])).toEqual([["alpha", "low"], ["beta", "medium"]]);
    expect(mergeVerdict({ context: c, outcomes, judge: NO_PLAN, classification }).level).toBe("medium");

    const steps = join(runDir(dir, "approve-5"), "steps");
    const prompt = readFileSync(join(steps, readdirSync(steps).find((f) => f.endsWith("-alpha.prompt.md")) as string), "utf8");
    expect(prompt).toContain("# Approval rubric");
    expect(prompt).toContain("#### Claims: Why");
    expect(prompt).toContain("Readers got lost.");
    expect(prompt).toContain("- tested: Links");
    expect(prompt).toContain("- PASS test");
    expect(prompt).toContain("No implementation plan is referenced");
    expect(prompt).toContain("floor none, ceiling none");
    expect(prompt).toContain("+# Approve");
  });

  test("a repo rubric replaces the shipped default and an out-of-range score is an error", async () => {
    const dir = tempRepo();
    const bad = { ...verdict("low"), dimensions: { ...verdict("low").dimensions, tests: { score: 4, reasons: [] } } };
    const { config } = fakeSetup(dir, [{ match: "approve (rubric)", structured: bad }]);
    const ctx = quietCtx(newState({ slug: "approve-6", repo: dir, ip: "", base: "master", phase: "build" }), config);
    const c = context(docsOnly, { policy: { approve: { ...DEFAULT_CONFIG.approve }, rubric: "# House rules\nBe kind.\n", source: "master@abc" } });
    const [o] = await runRubric(ctx, c, classify(["docs/approve.md"], DEFAULT_CONFIG.approve.pathRules), null);
    expect(o.verdict).toBeUndefined();
    expect(o.error).toContain("tests score");
    const steps = join(runDir(dir, "approve-6"), "steps");
    const prompt = readFileSync(join(steps, readdirSync(steps).find((f) => f.endsWith(".prompt.md")) as string), "utf8");
    expect(prompt).toContain("# House rules");
    expect(prompt).not.toContain("# Approval rubric");
    expect(DEFAULT_RUBRIC).toContain("## Blocking findings");
  });
});
