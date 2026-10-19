// The review body and check run a verdict turns into. One review per head, found again
// by the marker; the first line carries the level and the decision.
import type { ApproveContext } from "./context.ts";
import type { Verdict } from "./review.ts";

export const MARKER_PREFIX = "<!-- brewery-approve:";
export const marker = (headSha: string): string => `${MARKER_PREFIX}${headSha} -->`;
export const markerSha = (body: string): string | null => new RegExp(`${MARKER_PREFIX}([0-9a-f]+) -->`).exec(body)?.[1] ?? null;

const LABELS: Record<string, string> = { ipMatch: "Plan match", architecture: "Architecture", tests: "Tests", evidence: "Evidence" };

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

const bandText = (verdict: Verdict): string => {
  const c = verdict.classification;
  const parts = [`Floor: ${c.floor ?? "none"}`, `Ceiling: ${c.ceiling ?? "none"}`];
  if (c.categories.length) parts.push(`Categories: ${c.categories.join(", ")}`);
  if (verdict.modelLevel && verdict.modelLevel !== verdict.level) parts.push(`Model said ${verdict.modelLevel}`);
  return parts.join(" · ");
};

export const firstLine = (verdict: Verdict): string => {
  const decision = verdict.approve ? "approved" : "not approved";
  const why = verdict.approve
    ? verdict.dimensions.ipMatch.reasons[0] ?? verdict.rationale.split(/(?<=\.)\s/)[0] ?? ""
    : verdict.reasons[0] ?? "";
  return `**Risk: ${verdict.level} — ${decision}.** ${why.replace(/\s+/g, " ")}`.trim();
};

export const renderBody = (verdict: Verdict, context: ApproveContext): string => {
  const lines: string[] = [marker(context.pr.headSha), firstLine(verdict), ""];
  if (!verdict.approve && verdict.reasons.length > 1) {
    lines.push("Also: " + verdict.reasons.slice(1).join("; ") + ".", "");
  }
  lines.push("| Dimension | Score | Why |", "| --- | --- | --- |");
  for (const [key, label] of Object.entries(LABELS)) {
    const d = verdict.dimensions[key as keyof Verdict["dimensions"]];
    lines.push(`| ${label} | ${d.score}/3 | ${cell(d.reasons.join("; ") || "—")} |`);
  }
  lines.push("", `<details><summary>Findings (${verdict.findings.length}), plan, and gates</summary>`, "");
  if (verdict.findings.length) {
    for (const f of verdict.findings) {
      const who = verdict.agents.length > 1 ? ` _(${f.agents.join(", ")})_` : "";
      lines.push(`- **${f.severity}** \`${cell(f.where)}\` — ${cell(f.attack)}${f.evidence ? ` · ${cell(f.evidence)}` : ""}${who}`);
    }
    lines.push("");
  }
  if (verdict.judge && verdict.judge.status !== "no_plan") {
    const j = verdict.judge;
    lines.push(`Plan: ${j.status}${j.planEdited ? ", edited in this PR" : ""} — ${cell(j.summary)}`);
    if (j.missing.length) lines.push(`- Missing: ${j.missing.map(cell).join("; ")}`);
    if (j.unrequested.length) lines.push(`- Unrequested: ${j.unrequested.map(cell).join("; ")}`);
    if (j.evidenceGaps.length) lines.push(`- Evidence gaps: ${j.evidenceGaps.map(cell).join("; ")}`);
    lines.push("");
  } else {
    lines.push("Plan: none referenced.", "");
  }
  if (verdict.rationale) lines.push(verdict.rationale.trim(), "");
  const g = verdict.gates;
  const checks = context.pr.checks.filter((c) => c.name !== "brewery/approve");
  lines.push(
    `Checks: ${g.checks} (${checks.length}) · Bot threads: ${g.botThreads} unresolved · Human changes requested: ${g.humanChangesRequested ? "yes" : "no"} · Size: ${g.size}`,
    bandText(verdict),
    `Policy: \`.brewery.json\` at \`${context.policy.source}\`, rubric ${context.policy.rubric === null ? "brewery default" : `\`${context.policy.approve.rubric}\``}, agents ${verdict.agents.join(", ") || "none"}${verdict.errors.length ? `, failed: ${verdict.errors.map((e) => `${e.agent} (${cell(e.error)})`).join("; ")}` : ""}`,
    "",
    "</details>",
  );
  return `${lines.join("\n")}\n`;
};

export const renderSkip = (headSha: string, reason: string): string => `${marker(headSha)}\n**Skipped.** ${reason}\n`;

export type CheckConclusion = "success" | "neutral" | "failure";

// success when approved; failure when a blocking finding or a PR-caused gate failure
// exists; neutral otherwise (above the level, comment-only mode, pending checks).
export const checkRun = (verdict: Verdict): { conclusion: CheckConclusion; title: string; summary: string } => {
  const blocking = verdict.findings.some((f) => f.severity === "blocking");
  const caused = verdict.gates.checks === "fail" || verdict.gates.size === "over";
  const conclusion: CheckConclusion = verdict.approve ? "success" : blocking || caused ? "failure" : "neutral";
  return {
    conclusion,
    title: `Risk: ${verdict.level} — ${verdict.approve ? "approved" : "not approved"}`,
    summary: verdict.approve ? verdict.rationale || "Approved." : [...verdict.reasons, "", verdict.rationale].join("\n").trim(),
  };
};
