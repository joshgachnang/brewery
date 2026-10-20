// The rubric step and the verdict. The model scores four dimensions and picks a level;
// code sets the gates, bounds the level with the classification, merges fan-out by the
// strictest answer, and decides approval.
import DEFAULT_RUBRIC from "../../templates/approval-rubric.md" with { type: "text" };
import type { ApproveConfig, RiskLevel } from "../config.ts";
import { rubricBody } from "../prompts.ts";
import { runStage, type Ctx } from "../step.ts";
import type { ApproveContext } from "./context.ts";
import { classify, decide, mergeLevel, type Classification, type Gates } from "./policy.ts";
import { DIMENSIONS, VERDICT_SCHEMA, validateVerdict, type Dimension, type DimensionScore, type JudgeReport, type ModelVerdict, type VerdictFinding } from "./schemas.ts";

export { DEFAULT_RUBRIC };

export const CHECK_NAME = "terreno/approve";

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

// The approver's own check run and the CI job it runs in are not evidence about the PR.
export const isSelfCheck = (name: string, approve: Pick<ApproveConfig, "selfChecks">): boolean =>
  name === CHECK_NAME || (approve.selfChecks ?? []).includes(name);

export const otherChecks = (context: Pick<ApproveContext, "pr" | "policy">): ApproveContext["pr"]["checks"] =>
  context.pr.checks.filter((c) => !isSelfCheck(c.name, context.policy.approve));

export const gatesFor = (context: ApproveContext, approve: ApproveConfig): Gates => {
  const others = context.pr.checks.filter((c) => !isSelfCheck(c.name, approve));
  const checks: Gates["checks"] = others.some((c) => c.bucket === "fail" || c.bucket === "cancel")
    ? "fail"
    : others.some((c) => c.bucket === "pending")
      ? "pending"
      : "pass";
  // A human's latest review decides; an older "changes requested" superseded by their approval does not.
  const latestByHuman = new Map<string, string>();
  for (const review of context.pr.reviews) {
    if (review.isBot || review.state === "COMMENTED" || review.state === "PENDING") continue;
    latestByHuman.set(review.author, review.state);
  }
  const lines = context.files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  return {
    checks,
    botThreads: context.pr.botThreads.length,
    humanChangesRequested: [...latestByHuman.values()].includes("CHANGES_REQUESTED"),
    // A limit of 0 turns that half of the size gate off.
    size: (approve.maxLines > 0 && lines > approve.maxLines) || (approve.maxFiles > 0 && context.files.length > approve.maxFiles) ? "over" : "ok",
  };
};

export interface RubricOutcome {
  agent: string;
  verdict?: ModelVerdict;
  error?: string;
}

export const runRubric = async (
  ctx: Ctx,
  context: ApproveContext,
  classification: Classification,
  judge: JudgeReport | null,
  budgetUsd?: number,
): Promise<RubricOutcome[]> => {
  const rubric = context.policy.rubric ?? DEFAULT_RUBRIC;
  const results = await runStage(ctx, "approve", rubricBody({ rubric, context, classification, judge }), {
    task: "rubric",
    parallel: true,
    readOnly: { schema: VERDICT_SCHEMA, budgetUsd },
  });
  return results.map((r) => {
    if (r.result.status !== "PASS") return { agent: r.agent, error: r.result.action };
    const verdict = validateVerdict(r.result.structured);
    return typeof verdict === "string" ? { agent: r.agent, error: verdict } : { agent: r.agent, verdict };
  });
};

export interface Verdict {
  level: RiskLevel;
  approve: boolean;
  // Why not approved, in order; empty when approved.
  reasons: string[];
  dimensions: Record<Dimension, DimensionScore>;
  findings: (VerdictFinding & { agents: string[] })[];
  rationale: string;
  classification: Classification;
  gates: Gates;
  judge: JudgeReport | null;
  // Agents that produced a verdict, and those that did not with why.
  agents: string[];
  errors: { agent: string; error: string }[];
  // The level the model(s) chose before floors and ceilings.
  modelLevel: RiskLevel | null;
}

const EMPTY_DIMENSIONS = (): Record<Dimension, DimensionScore> => ({
  ipMatch: { score: 0, reasons: [] },
  architecture: { score: 0, reasons: [] },
  tests: { score: 0, reasons: [] },
  evidence: { score: 0, reasons: [] },
});

// Fan-out: the strictest level, the lowest score per dimension with every reason, findings
// unioned by location and attack, and every agent's rationale.
export const mergeVerdict = (input: {
  context: ApproveContext;
  outcomes: RubricOutcome[];
  judge: JudgeReport | null;
  classification?: Classification;
}): Verdict => {
  const approveConfig = input.context.policy.approve;
  const classification = input.classification ?? classify(input.context.files.map((f) => f.path), approveConfig.pathRules);
  const gates = gatesFor(input.context, approveConfig);
  const verdicts = input.outcomes.flatMap((o) => (o.verdict ? [{ agent: o.agent, verdict: o.verdict }] : []));
  const errors = input.outcomes.flatMap((o) => (o.error ? [{ agent: o.agent, error: o.error }] : []));
  const reasons: string[] = [];

  let modelLevel: RiskLevel = "low";
  const dimensions = EMPTY_DIMENSIONS();
  const findings: Verdict["findings"] = [];
  verdicts.forEach(({ agent, verdict }, index) => {
    modelLevel = RANK[modelLevel] >= RANK[verdict.level] ? modelLevel : verdict.level;
    for (const name of DIMENSIONS) {
      const mine = verdict.dimensions[name];
      const merged = dimensions[name];
      merged.score = index === 0 ? mine.score : (Math.min(merged.score, mine.score) as DimensionScore["score"]);
      for (const reason of mine.reasons) if (!merged.reasons.includes(reason)) merged.reasons.push(reason);
    }
    for (const finding of verdict.findings) {
      const same = findings.find((f) => f.where === finding.where && f.attack === finding.attack);
      if (same) {
        if (!same.agents.includes(agent)) same.agents.push(agent);
        continue;
      }
      findings.push({ ...finding, agents: [agent] });
    }
  });
  const order = { blocking: 0, "should-fix": 1, nit: 2 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  // A plan changed in the same PR is never low, whatever the model said.
  const floor = input.judge?.planEdited && (!classification.floor || RANK[classification.floor] < RANK.medium) ? "medium" : classification.floor;
  let level: RiskLevel;
  if (!verdicts.length) {
    level = "high";
    reasons.push(`no agent produced a verdict (${errors.map((e) => `${e.agent}: ${e.error}`).join("; ") || "none ran"})`);
  } else {
    level = mergeLevel(modelLevel, floor, classification.ceiling);
  }
  const blocking = findings.filter((f) => f.severity === "blocking").length;
  const decision = decide({ level, approveLevels: approveConfig.approveLevels, gates, blocking, never: classification.never });
  return {
    level,
    approve: decision.approve && verdicts.length > 0,
    reasons: [...reasons, ...decision.reasons],
    dimensions,
    findings,
    rationale: verdicts.map((v) => (verdicts.length > 1 ? `${v.agent}: ${v.verdict.rationale}` : v.verdict.rationale)).join("\n\n"),
    classification: { ...classification, floor },
    gates,
    judge: input.judge,
    agents: verdicts.map((v) => v.agent),
    errors,
    modelLevel: verdicts.length ? modelLevel : null,
  };
};
