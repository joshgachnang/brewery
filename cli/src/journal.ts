// A run's journal: rendered by brewery from its own state, not written by an agent, so it
// is a faithful record to review later. Committed on the PR branch under docs/journal/.
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { readFailures } from "./ci.ts";
import { readIp, title } from "./ip.ts";
import type { RunState } from "./state.ts";

export const JOURNAL_DIR = "docs/journal";

export const journalPath = (state: RunState, date = new Date()): string =>
  join(state.repo, JOURNAL_DIR, `${date.toISOString().slice(0, 10)}-${state.slug}.md`);

const duration = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m${String(s).padStart(2, "0")}s`;
};

const cell = (text: string, max = 140): string => {
  const flat = text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const short = (sha?: string): string => (sha ? sha.slice(0, 8) : "");

export const renderJournal = (state: RunState, learning?: string | null, decisions: string[] = [], phi = false): string => {
  const ipText = state.ip && existsSync(state.ip) ? readIp(state.ip) : "";
  const total = state.history.reduce((sum, h) => sum + h.seconds, 0);
  const lines: string[] = [`# Journal: ${ipText ? title(ipText) : state.slug}`, ""];
  lines.push(`- Run: \`${state.slug}\``);
  if (state.ip) lines.push(`- Plan: [${relative(state.repo, state.ip)}](../../${relative(state.repo, state.ip)})`);
  if (state.branch) lines.push(`- Branch: \`${state.branch}\`${state.pr ? `, PR #${state.pr}` : ""}`);
  lines.push(`- Agent time: ${duration(total)} over ${state.history.length} steps`);
  if (state.finish) lines.push(`- Finish: ${state.finish.reactions} reactions, ${state.finish.pushes} fix pushes`);
  if (learning) lines.push(`- Learning: [${learning}](../../${learning})`);
  for (const d of decisions) lines.push(`- Decision: [${d}](../../${d})`);
  lines.push("");

  const stages = new Map<string, { steps: number; fails: number; seconds: number }>();
  for (const h of state.history) {
    const s = stages.get(h.stage) ?? { steps: 0, fails: 0, seconds: 0 };
    s.steps += 1;
    s.fails += h.status === "FAIL" ? 1 : 0;
    s.seconds += h.seconds;
    stages.set(h.stage, s);
  }
  if (stages.size) {
    lines.push("## Stages", "", "| Stage | Steps | Fails | Time |", "| --- | --- | --- | --- |");
    for (const [stage, s] of stages) lines.push(`| ${stage} | ${s.steps} | ${s.fails} | ${duration(s.seconds)} |`);
    lines.push("");
  }

  const tasks = Object.entries(state.tasks);
  if (tasks.length) {
    lines.push("## Tasks", "", "| Task | Status | Attempts | Commit |", "| --- | --- | --- | --- |");
    for (const [id, t] of tasks) lines.push(`| ${id} | ${t.status} | ${t.attempts} | ${short(t.commit)} |`);
    lines.push("");
  }

  if (state.answers.length) {
    lines.push("## Human answers", "");
    for (const a of state.answers) lines.push(`- ${a.at.slice(0, 16)} — ${cell(a.q, 200)}`, `  - ${cell(a.a, 400)}`);
    lines.push("");
  }

  const failures = readFailures(state);
  if (failures.length) {
    lines.push("## CI failures", "");
    for (const { failure: f } of failures) {
      const outcome = f.status === "fixed" ? `fixed in ${short(f.fixSha)}` : f.status;
      lines.push(`### ${f.check} at ${short(f.sha)} — ${outcome}`, "");
      if (f.link) lines.push(f.link, "");
      // In a PHI repo the log stays in the git-ignored run state.
      const tail = phi ? "" : f.log.split("\n").slice(-20).join("\n").trim();
      if (tail) lines.push("~~~", tail, "~~~", "");
      else if (phi && f.log) lines.push("Log kept out of the repo (PHI); see the run's `ci/` state.", "");
    }
  }

  if (state.history.length) {
    lines.push("## Timeline", "", "| # | Step | Agent | Status | Time | Result |", "| --- | --- | --- | --- | --- | --- |");
    for (const h of state.history) {
      lines.push(`| ${h.seq} | ${h.stage}${h.task ? ` ${h.task}` : ""} | ${h.agent} | ${h.status} | ${duration(h.seconds)} | ${cell(h.action)} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
};

// The fail evidence a step recorded, read back from its result file.
export const stepFails = (log: string): string[] => {
  const path = log.replace(/\.log$/, ".result.json");
  if (!existsSync(path)) return [];
  try {
    const result = JSON.parse(readFileSync(path, "utf8")) as { fail?: { need: string; got: string; ev: string }[] };
    return (result.fail ?? []).map((f) => `${f.need}: got ${f.got} (${f.ev})`);
  } catch {
    return [];
  }
};
