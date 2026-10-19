// JSON schemas the read-only approve steps are launched with, and the validators that
// re-check the answers in code (a schema cannot enforce ranges or enum semantics
// everywhere, and codex/command agents are not schema-constrained at all).
import type { RiskLevel } from "../config.ts";

export interface JudgeReport {
  status: "aligned" | "drift" | "no_plan";
  // Claimed tasks or acceptance criteria the diff does not deliver.
  missing: string[];
  // Behavior in the diff that no claimed task asks for.
  unrequested: string[];
  // The PR changes the plan it claims to implement.
  planEdited: boolean;
  // Acceptance criteria whose named verification is absent from the PR.
  evidenceGaps: string[];
  summary: string;
}

export const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "missing", "unrequested", "planEdited", "evidenceGaps", "summary"],
  properties: {
    status: { type: "string", enum: ["aligned", "drift", "no_plan"] },
    missing: { type: "array", items: { type: "string" } },
    unrequested: { type: "array", items: { type: "string" } },
    planEdited: { type: "boolean" },
    evidenceGaps: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
} as const;

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");

export const validateJudge = (value: unknown): JudgeReport | string => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "judge report is not an object";
  const v = value as Record<string, unknown>;
  if (!["aligned", "drift", "no_plan"].includes(String(v.status))) return `judge status "${v.status}" is not aligned/drift/no_plan`;
  for (const key of ["missing", "unrequested", "evidenceGaps"]) {
    if (!isStringArray(v[key])) return `judge ${key} is not a list of strings`;
  }
  if (typeof v.planEdited !== "boolean") return "judge planEdited is not a boolean";
  if (typeof v.summary !== "string") return "judge summary is not a string";
  return {
    status: v.status as JudgeReport["status"],
    missing: v.missing as string[],
    unrequested: v.unrequested as string[],
    planEdited: v.planEdited,
    evidenceGaps: v.evidenceGaps as string[],
    summary: v.summary,
  };
};

export const DIMENSIONS = ["ipMatch", "architecture", "tests", "evidence"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface DimensionScore {
  // 0 absent, 1 weak, 2 adequate, 3 strong
  score: 0 | 1 | 2 | 3;
  reasons: string[];
}

export interface VerdictFinding {
  severity: "blocking" | "should-fix" | "nit";
  where: string;
  attack: string;
  evidence: string;
}

// What the rubric agent returns. Code fills classification, gates, and approve afterwards.
export interface ModelVerdict {
  level: RiskLevel;
  dimensions: Record<Dimension, DimensionScore>;
  findings: VerdictFinding[];
  rationale: string;
}

const dimensionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["score", "reasons"],
  properties: { score: { type: "integer", enum: [0, 1, 2, 3] }, reasons: { type: "array", items: { type: "string" } } },
} as const;

export const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["level", "dimensions", "findings", "rationale"],
  properties: {
    level: { type: "string", enum: ["low", "medium", "high"] },
    dimensions: {
      type: "object",
      additionalProperties: false,
      required: [...DIMENSIONS],
      properties: { ipMatch: dimensionSchema, architecture: dimensionSchema, tests: dimensionSchema, evidence: dimensionSchema },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "where", "attack", "evidence"],
        properties: {
          severity: { type: "string", enum: ["blocking", "should-fix", "nit"] },
          where: { type: "string" },
          attack: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
    rationale: { type: "string" },
  },
} as const;

export const validateVerdict = (value: unknown): ModelVerdict | string => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "verdict is not an object";
  const v = value as Record<string, unknown>;
  if (!["low", "medium", "high"].includes(String(v.level))) return `verdict level "${v.level}" is not low/medium/high`;
  const dims = v.dimensions as Record<string, unknown> | undefined;
  if (!dims || typeof dims !== "object") return "verdict dimensions missing";
  const dimensions = {} as Record<Dimension, DimensionScore>;
  for (const name of DIMENSIONS) {
    const d = dims[name] as Record<string, unknown> | undefined;
    if (!d || typeof d !== "object") return `verdict dimension ${name} missing`;
    if (![0, 1, 2, 3].includes(d.score as number)) return `verdict dimension ${name} score "${d.score}" is not 0-3`;
    if (!isStringArray(d.reasons)) return `verdict dimension ${name} reasons is not a list of strings`;
    dimensions[name] = { score: d.score as DimensionScore["score"], reasons: d.reasons };
  }
  if (!Array.isArray(v.findings)) return "verdict findings is not a list";
  const findings: VerdictFinding[] = [];
  for (const raw of v.findings) {
    const f = raw as Record<string, unknown>;
    if (!f || !["blocking", "should-fix", "nit"].includes(String(f.severity))) return `finding severity "${f?.severity}" is not blocking/should-fix/nit`;
    for (const key of ["where", "attack", "evidence"]) if (typeof f[key] !== "string") return `finding ${key} is not a string`;
    findings.push({ severity: f.severity as VerdictFinding["severity"], where: f.where as string, attack: f.attack as string, evidence: f.evidence as string });
  }
  if (typeof v.rationale !== "string") return "verdict rationale is not a string";
  return { level: v.level as RiskLevel, dimensions, findings, rationale: v.rationale };
};
