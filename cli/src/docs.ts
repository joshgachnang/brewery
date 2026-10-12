// The standard docs layout in a target repo: decisions, journals, learnings, and the
// capped rules file every stage reads. Plans and specs already have their own homes.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import DECISION from "../templates/decision.md" with { type: "text" };
import LEARNING from "../templates/learning.md" with { type: "text" };
import RULES from "../templates/rules.md" with { type: "text" };

export const RULES_PATH = "docs/learnings/RULES.md";

export const POINTER =
  "- Past runs: rules in `docs/learnings/RULES.md` (follow them), learnings in `docs/learnings/` (grep the frontmatter by module and tags), durable decisions in `docs/decisions/`, run journals in `docs/journal/`.";

const FILES: Record<string, string> = {
  [RULES_PATH]: RULES,
  "docs/learnings/TEMPLATE.md": LEARNING,
  "docs/decisions/TEMPLATE.md": DECISION,
  "docs/journal/.gitkeep": "",
};

// The Active section of the repo's RULES.md, as bullet lines. Empty when there are none.
export const activeRules = (repo: string): string[] => {
  const path = join(repo, RULES_PATH);
  if (!existsSync(path)) return [];
  const section = readFileSync(path, "utf8").split(/^## /m).find((s) => s.startsWith("Active"));
  return (section ?? "").split("\n").filter((line) => line.startsWith("- "));
};

// Create whatever is missing and point the repo's agent instructions at it. Never
// overwrites. Returns the repo-relative paths it created or changed.
export const initDocs = (repo: string): string[] => {
  const changed: string[] = [];
  for (const [path, body] of Object.entries(FILES)) {
    const full = join(repo, path);
    if (existsSync(full)) continue;
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
    changed.push(path);
  }
  // One pointer is enough: if any instructions file already names RULES.md, touch none.
  const instructions = ["AGENTS.md", "CLAUDE.md"].filter((name) => existsSync(join(repo, name)));
  if (instructions.some((name) => readFileSync(join(repo, name), "utf8").includes(RULES_PATH))) return changed;
  for (const name of instructions.length ? instructions : ["CLAUDE.md"]) {
    const full = join(repo, name);
    const current = existsSync(full) ? readFileSync(full, "utf8") : "";
    appendFileSync(full, `${current && !current.endsWith("\n") ? "\n" : ""}${current ? "\n" : ""}${POINTER}\n`);
    changed.push(name);
  }
  return changed;
};
