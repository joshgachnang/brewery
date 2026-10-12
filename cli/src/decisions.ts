// Decisions that outlive their plan. distill marks a row in the IP's Decisions table
// `D2 (durable)`; at the end of the run brewery copies it to docs/decisions/NNNN-<slug>.md
// and replaces the marker with a link, so it is promoted exactly once.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { readIp, writeIp } from "./ip.ts";
import { slugify } from "./state.ts";

export const DECISIONS_DIR = "docs/decisions";

const MARKER = /\(durable\)/i;

interface Row {
  line: string;
  id: string;
  question: string;
  answer: string;
  changes: string;
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

export const durableRows = (ipText: string): Row[] => {
  const section = ipText.split(/^## /m).find((s) => s.startsWith("Decisions"));
  if (!section) return [];
  return section
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .map((line) => ({ line, c: cells(line) }))
    .filter(({ c }) => c.length >= 3 && MARKER.test(c[0]))
    .map(({ line, c }) => ({ line, id: c[0], question: c[1], answer: c[2], changes: c[3] ?? "" }));
};

const nextNumber = (dir: string): number => {
  if (!existsSync(dir)) return 1;
  const used = readdirSync(dir)
    .map((f) => /^(\d{4})-/.exec(f)?.[1])
    .filter(Boolean)
    .map(Number);
  return used.length ? Math.max(...used) + 1 : 1;
};

const render = (num: string, row: Row, ipRel: string, date: string): string => {
  const heading = row.answer.length <= 80 ? row.answer : row.question;
  return `# ${num} — ${heading}

Date: ${date}
Status: accepted
Plan: [${ipRel}](../../${ipRel}) (${row.id.replace(MARKER, "").trim()})

## Context

${row.question}

## Decision

${row.answer}

## Consequences

${row.changes || "See the plan."}
`;
};

// Returns the repo-relative paths of the decision files written.
export const promoteDecisions = (repo: string, ip: string, date = new Date()): string[] => {
  const dir = join(repo, DECISIONS_DIR);
  if (!ip || !existsSync(ip) || !existsSync(dir)) return [];
  let text = readIp(ip);
  const rows = durableRows(text);
  const written: string[] = [];
  let n = nextNumber(dir);
  for (const row of rows) {
    const num = String(n++).padStart(4, "0");
    const file = join(dir, `${num}-${slugify(row.answer.length <= 80 ? row.answer : row.question) || "decision"}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, render(num, row, relative(repo, ip), date.toISOString().slice(0, 10)));
    const link = `[${num}](${relative(dirname(ip), file)})`;
    text = text.replace(row.line, row.line.replace(MARKER, `(durable: ${link})`));
    written.push(relative(repo, file));
  }
  if (written.length) writeIp(ip, text);
  return written;
};
