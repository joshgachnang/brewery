// The clean plan judge. It sees the plan, the task scope the PR claims, and the diff.
// Never the PR body, the rubric, or another agent's opinion, the way cut sees only the
// human's words. Code owns planEdited: a plan changed in the PR is flagged whatever the
// model says.
import { judgeBody } from "../prompts.ts";
import { runStage, type Ctx } from "../step.ts";
import type { ApproveContext } from "./context.ts";
import { JUDGE_SCHEMA, validateJudge, type JudgeReport } from "./schemas.ts";

export interface JudgeOutcome {
  agent: string;
  report?: JudgeReport;
  // Why this agent produced no usable report.
  error?: string;
}

export const NO_PLAN: JudgeReport = {
  status: "no_plan",
  missing: [],
  unrequested: [],
  planEdited: false,
  evidenceGaps: [],
  summary: "No implementation plan is referenced by this PR.",
};

export const runJudge = async (ctx: Ctx, context: ApproveContext, budgetUsd?: number): Promise<JudgeOutcome[]> => {
  if (!context.plans.length) return [{ agent: "none", report: NO_PLAN }];
  const results = await runStage(ctx, "approve", judgeBody(context.plans, context.scope, context.diff), {
    task: "judge",
    parallel: true,
    readOnly: { schema: JUDGE_SCHEMA, budgetUsd },
  });
  const planEdited = context.plans.some((p) => p.editedInPr);
  return results.map((r) => {
    if (r.result.status !== "PASS") return { agent: r.agent, error: r.result.action };
    const report = validateJudge(r.result.structured);
    if (typeof report === "string") return { agent: r.agent, error: report };
    return { agent: r.agent, report: { ...report, planEdited: report.planEdited || planEdited } };
  });
};

const union = (lists: string[][]): string[] => {
  const out: string[] = [];
  for (const item of lists.flat()) if (!out.includes(item)) out.push(item);
  return out;
};

// Fan-out: any drift is drift; lists are unioned; planEdited if any agent (or code) says so.
export const mergeJudges = (outcomes: JudgeOutcome[]): JudgeReport | null => {
  const reports = outcomes.flatMap((o) => (o.report ? [o.report] : []));
  if (!reports.length) return null;
  if (reports.every((r) => r.status === "no_plan")) return reports[0];
  const live = reports.filter((r) => r.status !== "no_plan");
  return {
    status: live.some((r) => r.status === "drift") ? "drift" : "aligned",
    missing: union(live.map((r) => r.missing)),
    unrequested: union(live.map((r) => r.unrequested)),
    planEdited: live.some((r) => r.planEdited),
    evidenceGaps: union(live.map((r) => r.evidenceGaps)),
    summary: live.map((r) => r.summary).join(" "),
  };
};
