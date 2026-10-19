// Deterministic half of `brewery approve`: path rules bound the risk level before any
// model sees the diff, and gates in code decide whether a level may be approved.
import type { PathRule, RiskLevel } from "../config.ts";

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
export const LEVELS: RiskLevel[] = ["low", "medium", "high"];

const higher = (a: RiskLevel | null, b: RiskLevel | null): RiskLevel | null => {
  if (!a) return b;
  if (!b) return a;
  return RANK[a] >= RANK[b] ? a : b;
};

export interface Classification {
  // Every category matched by any changed file, in first-seen order. "source" when no rule matched.
  categories: string[];
  // Highest floor of any matched rule, or null.
  floor: RiskLevel | null;
  // Set only when every changed file matches a ceiling rule; then the loosest per-file ceiling.
  ceiling: RiskLevel | null;
  // Files matched by a `never` rule, in diff order.
  never: string[];
}

const matches = (file: string, rule: PathRule): boolean => rule.match.some((pattern) => new Bun.Glob(pattern).match(file));

export const classify = (files: string[], rules: PathRule[]): Classification => {
  const categories: string[] = [];
  const never: string[] = [];
  let floor: RiskLevel | null = null;
  let ceiling: RiskLevel | null = null;
  let everyFileCapped = files.length > 0;
  for (const file of files) {
    const matched = rules.filter((rule) => matches(file, rule));
    if (!matched.length && !categories.includes("source")) categories.push("source");
    let fileCeiling: RiskLevel | null = null;
    for (const rule of matched) {
      if (!categories.includes(rule.category)) categories.push(rule.category);
      if (rule.floor) floor = higher(floor, rule.floor);
      if (rule.ceiling) fileCeiling = higher(fileCeiling, rule.ceiling);
      if (rule.never && !never.includes(file)) never.push(file);
    }
    if (fileCeiling) ceiling = higher(ceiling, fileCeiling);
    else everyFileCapped = false;
  }
  return { categories, floor, ceiling: everyFileCapped ? ceiling : null, never };
};

// The model's level, raised to the floor, then capped by the ceiling. A floor above the
// ceiling wins: a ceiling never lowers a level below a floor.
export const mergeLevel = (model: RiskLevel, floor: RiskLevel | null, ceiling: RiskLevel | null): RiskLevel => {
  let level = higher(model, floor) as RiskLevel;
  if (ceiling) {
    const cap = higher(ceiling, floor) as RiskLevel;
    if (RANK[level] > RANK[cap]) level = cap;
  }
  return level;
};

export interface Gates {
  checks: "pass" | "fail" | "pending";
  botThreads: number;
  humanChangesRequested: boolean;
  size: "ok" | "over";
}

export interface Decision {
  approve: boolean;
  // Why not, in the order a reviewer should read them. Empty when approved.
  reasons: string[];
}

export const decide = (input: {
  level: RiskLevel;
  approveLevels: RiskLevel[];
  gates: Gates;
  blocking: number;
  never: string[];
}): Decision => {
  const reasons: string[] = [];
  if (!input.approveLevels.length) reasons.push("approveLevels is empty, so this repo is in comment-only mode");
  else if (!input.approveLevels.includes(input.level)) {
    reasons.push(`risk ${input.level} is above the configured approval levels (${input.approveLevels.join(", ")})`);
  }
  if (input.blocking > 0) reasons.push(`${input.blocking} blocking finding${input.blocking === 1 ? "" : "s"}`);
  if (input.gates.checks === "fail") reasons.push("checks on this head are failing");
  if (input.gates.checks === "pending") reasons.push("checks on this head are still pending");
  if (input.gates.botThreads > 0) {
    reasons.push(`${input.gates.botThreads} unresolved bot review thread${input.gates.botThreads === 1 ? "" : "s"}`);
  }
  if (input.gates.humanChangesRequested) reasons.push("a human requested changes");
  if (input.gates.size === "over") reasons.push("diff is over the size limit");
  if (input.never.length) reasons.push(`policy files changed: ${input.never.join(", ")}`);
  return { approve: reasons.length === 0, reasons };
};
