// Attack the IP from the human's side. The attackers run in a clean worktree of HEAD,
// where .terreno/ (research, state, transcripts) does not exist, and their prompt holds
// only the human's words. That is what makes "only the user's context" enforceable.
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { Finding } from "../agents.ts";
import { cutBody } from "../prompts.ts";
import { readContext } from "../state.ts";
import { runStage, type Ctx } from "../step.ts";
import { addWorktree, removeWorktree } from "../vcs.ts";

const SEVERITY_ORDER = { blocking: 0, "should-fix": 1, nit: 2 } as const;

export const runCut = async (ctx: Ctx): Promise<Finding[]> => {
  const { state } = ctx;
  const dir = mkdtempSync(join(tmpdir(), `brewery-cut-${state.slug}-`));
  const tree = join(dir, "tree");
  await addWorktree(state.repo, tree);
  try {
    // The IP is usually uncommitted during distill; give the attackers the current text.
    const ipRel = relative(state.repo, state.ip);
    mkdirSync(dirname(join(tree, ipRel)), { recursive: true });
    copyFileSync(state.ip, join(tree, ipRel));
    const results = await runStage(ctx, "cut", cutBody(ctx, readContext(state), ipRel), { cwd: tree, parallel: true });
    const findings = results.flatMap((r) =>
      (r.result.findings ?? []).filter((f) => f.evidence?.trim()).map((f) => ({ ...f, agent: r.agent })),
    );
    findings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3));
    const blocking = findings.filter((f) => f.severity === "blocking").length;
    ctx.log(`  cut: ${findings.length} findings (${blocking} blocking) from ${results.map((r) => r.agent).join(", ")}`);
    return findings;
  } finally {
    await removeWorktree(state.repo, tree, ctx.log);
  }
};

export const findingsTable = (findings: Finding[]): string => {
  if (!findings.length) return "No findings.";
  const cell = (s: string | undefined): string => (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const rows = findings.map(
    (f, i) =>
      `| ${f.id ?? `C${i + 1}`} | ${f.severity} | ${cell(f.agent)} | ${cell(f.where)} | ${cell(f.attack)} | ${cell(f.evidence)} | ${cell(f.fix)} |`,
  );
  return ["| ID | Severity | Agent | Where | Attack | Evidence | Suggested fix |", "| --- | --- | --- | --- | --- | --- | --- |", ...rows].join(
    "\n",
  );
};
