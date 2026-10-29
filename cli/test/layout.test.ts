// The docs layout, the terreno pipeline projection, and CI failure evidence.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failureExcerpt, readFailures } from "../src/ci.ts";
import { finish } from "../src/commands/finish.ts";
import { initDocs, RULES_PATH } from "../src/docs.ts";
import { pipelinePath, projectPipeline } from "../src/pipeline.ts";
import { scrub, scrubTail } from "../src/scrub.ts";
import { newState, saveState, type RunState } from "../src/state.ts";
import type { PrSnapshot } from "../src/vcs.ts";
import { fakeCi, fakeSetup, quietCtx, tempRepo } from "./helpers.ts";

const SKILLS_DIR = join(import.meta.dir, "..", "..", "plugins", "brewery", "skills");
const SCHEMA_DIR = join(SKILLS_DIR, "terreno-shared");

interface Schema {
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  enum?: unknown[];
  const?: unknown;
  items?: Schema;
  type?: string | string[];
}

// Enough of JSON Schema for execution-state: required, closed objects, enums, consts, arrays.
const violations = (value: unknown, schema: Schema, path = "$"): string[] => {
  const out: string[] = [];
  if (schema.const !== undefined && value !== schema.const) out.push(`${path}: want ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) out.push(`${path}: ${value} not in enum`);
  if (schema.type === "integer" && !Number.isInteger(value)) out.push(`${path}: not an integer`);
  if (schema.type === "string" && typeof value !== "string") out.push(`${path}: not a string`);
  if (schema.items && Array.isArray(value)) value.forEach((v, i) => out.push(...violations(v, schema.items as Schema, `${path}[${i}]`)));
  if (schema.properties && value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) out.push(`${path}.${key}: missing`);
    for (const [key, v] of Object.entries(obj)) {
      const sub = schema.properties[key];
      if (!sub) {
        if (schema.additionalProperties === false) out.push(`${path}.${key}: not allowed`);
      } else out.push(...violations(v, sub, `${path}.${key}`));
    }
  }
  return out;
};

const schema = (): Schema => JSON.parse(readFileSync(join(SCHEMA_DIR, "execution-state.schema.json"), "utf8")) as Schema;

describe("init-docs", () => {
  test("creates the layout, points CLAUDE.md at it, and is idempotent", () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "CLAUDE.md"), "# Repo\n\nSome rules.");
    const first = initDocs(repo);
    expect(first).toEqual([RULES_PATH, "docs/learnings/TEMPLATE.md", "docs/decisions/TEMPLATE.md", "docs/journal/.gitkeep", "CLAUDE.md"]);
    expect(readFileSync(join(repo, RULES_PATH), "utf8")).toContain("## Active");
    expect(readFileSync(join(repo, "docs/learnings/TEMPLATE.md"), "utf8")).toContain("problem_type:");
    const claude = readFileSync(join(repo, "CLAUDE.md"), "utf8");
    expect(claude).toStartWith("# Repo\n\nSome rules.\n\n- Past runs:");
    expect(initDocs(repo)).toEqual([]);
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe(claude);
  });

  test("adds no pointer anywhere when one instructions file already names RULES.md", () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "AGENTS.md"), "# Network inventory\n");
    writeFileSync(join(repo, "CLAUDE.md"), `# Repo\n\nRules live in ${RULES_PATH}.\n`);
    expect(initDocs(repo)).not.toContain("AGENTS.md");
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe("# Network inventory\n");
  });

  test("prefers existing AGENTS.md and leaves an edited RULES.md alone", () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "AGENTS.md"), "# Agents\n");
    initDocs(repo);
    expect(existsSync(join(repo, "CLAUDE.md"))).toBe(false);
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toContain(RULES_PATH);
    writeFileSync(join(repo, RULES_PATH), "# Rules\n\n## Active\n\n- Run lint before push.\n");
    initDocs(repo);
    expect(readFileSync(join(repo, RULES_PATH), "utf8")).toContain("Run lint before push.");
  });
});

// bun test and typecheck never read skill text, so these checks are the testing-plan
// contract's only guard in brewery's planning skills.
const E2E_TABLE = "| ID | Spec or flow | Layer | Proves | Written in |";
const REGRESSION_TABLE = "| ID | Case | Steps | Expected | Platforms | Automated by | Added |";
const LEGACY = "None — predates contract";
const GUIDE_TABLE = "| ID | Page | Change | Audience | Written in |";
const GUIDE_OFF = "None — user guide off";
const DESIGN_TABLE = "| Artboard | States and flows | Tasks | Notes |";
const SNAPSHOT = "docs/specs/<slug>/design/";
const CUT_RULES = [
  "no `## E2E tests` or no `## Regression cases` section",
  "no `## User guide` section",
  "a section says `None` with no reason",
  "no planned spec in `## E2E tests`",
  "has no `## User guide` row",
];
const RECIPE_NEVER = [
  "write to Linear, or start a design, before the human's answer to the preview",
  "alter an existing artboard or a note it did not add",
  "create an initiative, label, or team",
  "delete or archive projects, milestones, or issues",
  "drop a fact, link, or decision from an existing description",
];

interface Contract {
  // Anywhere in the text, after reflow.
  phrases: string[];
  // A line that starts with this: template headings and brief lines.
  lines?: string[];
  // Phrases that must sit between two markers, such as cut's blocking list.
  within?: { from: string; to: string; phrases: string[] };
}

const CONTRACT: Record<string, Contract> = {
  "terreno-shared/testing-plan.md": {
    phrases: ["docs/testing/e2e.md", "docs/regression/", "## Testing conventions", E2E_TABLE, REGRESSION_TABLE, "None — <reason>", "row as `deferred` with the exact command", LEGACY],
  },
  "terreno-shared/user-guide.md": {
    phrases: ["docs/user-guide/", "## User guide conventions", "### Opting out", GUIDE_OFF, GUIDE_TABLE, "## Guide-entry bar", "None — <reason>", "predates contract"],
  },
  "distill/SKILL.md": {
    phrases: ["../terreno-shared/testing-plan.md", "../terreno-shared/user-guide.md", "docs/testing/e2e.md", "Pair each UI or cross-process criterion with a planned spec", "## E2E tests", "## Regression cases", "## User guide", GUIDE_OFF, LEGACY, "references/designing.md", "then `## Design` per", SNAPSHOT, "A canvas that changed since the snapshot is a reply too"],
  },
  "distill/references/distilling.md": {
    phrases: [E2E_TABLE, REGRESSION_TABLE, GUIDE_TABLE, "None — <reason>", GUIDE_OFF, LEGACY, "then `## Design` in the format of"],
    lines: ["## E2E tests", "## Regression cases", "## User guide", "E2E: ", "Regression: ", "User guide: ", "Design: ", "Elephant: "],
  },
  "distill/references/designing.md": {
    phrases: [DESIGN_TABLE, SNAPSHOT, "None — <reason>", LEGACY, "A planning run only adds to a canvas", "Never edit, move, resize, or delete an existing artboard", "never read the live canvas", "never silently overrules", "Never render, screenshot, or open a canvas"],
    lines: ["## Reaching the canvas", "## What a planning run may add", "## Checkpoints", "## Applying canvas changes", "## The `## Design` section", "## The snapshot", "## Design"],
  },
  "pour/SKILL.md": {
    phrases: ["## E2E tests", "## Regression cases", "## User guide", "## Design", GUIDE_OFF],
  },
  "barrel/stages/pick.md": {
    phrases: ["../../terreno-shared/user-guide.md", "## User guide", "skip a guide row silently", "opts out of the user guide", SNAPSHOT, "Build to the snapshot, never to the live canvas", "../references/approval-ready.md"],
  },
  "barrel/stages/roast.md": {
    phrases: ["../../terreno-shared/user-guide.md", "## User guide", "guide-entry bar", "shipped screens", "match the snapshot, not the live canvas", "../references/approval-ready.md"],
  },
  "barrel/stages/brew.md": {
    phrases: ["../../terreno-shared/user-guide.md", "## User guide", "guide index", "Unless the repository opts out", "`Provenance` section", "write `unknown` for the rest", "../references/approval-ready.md"],
  },
  "barrel/SKILL.md": {
    phrases: ["references/approval-ready.md", "push a branch you have not checked against"],
  },
  "barrel/references/approval-ready.md": {
    phrases: ["git show origin/<base>:<path>", "Always have a plan", "Nothing unrequested", "Blocking findings", "first cell of every row", "names the blocked behavior and the exact steps", "approve.maxLines"],
  },
  "tap/SKILL.md": {
    phrases: ["../barrel/references/approval-ready.md", "push a branch you have not checked against", "fix IP's path in backticks and the task ids"],
  },
  "finish/taste.md": {
    phrases: ["../terreno-shared/user-guide.md", "## User guide", "user guide pages", "guide-entry bar"],
  },
  "cut/SKILL.md": {
    phrases: [LEGACY, GUIDE_OFF, "Attack the `## Design` section", "**Well-reasoned:**", "**Couldn't assess:**", "<w> well-reasoned, <u> couldn't assess"],
    within: { from: "Each of these is `blocking`", to: "Also attack regression steps", phrases: CUT_RULES },
  },
  "tap/references/triage.md": {
    phrases: [E2E_TABLE, REGRESSION_TABLE, GUIDE_TABLE, "None — <reason>", GUIDE_OFF],
    lines: ["## E2E tests", "## Regression cases", "## User guide"],
  },
  "recipe/SKILL.md": {
    phrases: ["references/shaping.md", "../distill/references/distilling.md", "../distill/references/designing.md", "../terreno-shared/reaching-the-human.md", "Nothing is written to Linear before this answer", "## Open questions (recommendation assumed)", "## Expansions (follow up later)", "## Decisions", "design brief", "Claude Design"],
    within: { from: "## Never", to: "commit `.terreno/recipe/`", phrases: RECIPE_NEVER },
  },
  "recipe/references/shaping.md": {
    phrases: ["## Linear access", "## Matching fields", "## The recipe bar", "## The improve diff", "## The preview", "## Design brief", "keeps every fact, link, decision", "Size: pour | distill | tap"],
    lines: ["## Milestones", "## Design", "## Open questions (recommendation assumed)", "## Expansions (follow up later)", "## Decisions", "## Links"],
  },
};

const skillText = (path: string): string => readFileSync(join(SKILLS_DIR, path), "utf8");

// Markdown reflows prose and blockquotes, so a phrase may be wrapped across lines.
const flatten = (text: string): string => text.replace(/^>\s?/gm, "").replace(/\s+/g, " ");

const contractGaps = (path: string, text: string): string[] => {
  const { phrases, lines = [], within } = CONTRACT[path];
  const flat = flatten(text);
  const rows = text.split("\n");
  const gaps = phrases.filter((phrase) => !flat.includes(phrase));
  gaps.push(...lines.filter((line) => !rows.some((row) => row.startsWith(line))).map((line) => `line: ${line}`));
  if (within) {
    const from = flat.indexOf(within.from);
    const to = flat.indexOf(within.to, from);
    const span = from === -1 || to === -1 ? "" : flat.slice(from, to);
    gaps.push(...within.phrases.filter((phrase) => !span.includes(phrase)).map((phrase) => `${within.from}: ${phrase}`));
  }
  return gaps;
};

// The text with the first line containing `marker` removed.
const dropLine = (text: string, marker: string): string => {
  const rows = text.split("\n");
  const at = rows.findIndex((row) => row.includes(marker));
  if (at === -1) throw new Error(`no line contains ${marker}`);
  return rows.filter((_, i) => i !== at).join("\n");
};

describe("testing-plan and user-guide contracts in the skill text", () => {
  for (const path of Object.keys(CONTRACT)) {
    test(`${path} carries the contract`, () => {
      expect(contractGaps(path, skillText(path))).toEqual([]);
    });
  }

  test("deleting either section heading from distill or tap is reported", () => {
    expect(contractGaps("distill/SKILL.md", dropLine(skillText("distill/SKILL.md"), "then `## E2E tests` and `## Regression cases`"))).toEqual(["## E2E tests", "## Regression cases"]);
    expect(contractGaps("distill/references/distilling.md", dropLine(skillText("distill/references/distilling.md"), "## E2E tests"))).toEqual(["line: ## E2E tests"]);
    expect(contractGaps("distill/references/distilling.md", dropLine(skillText("distill/references/distilling.md"), "## Regression cases"))).toEqual(["line: ## Regression cases"]);
    expect(contractGaps("tap/references/triage.md", dropLine(skillText("tap/references/triage.md"), "## E2E tests"))).toEqual(["line: ## E2E tests"]);
    expect(contractGaps("tap/references/triage.md", dropLine(skillText("tap/references/triage.md"), "## Regression cases"))).toEqual(["line: ## Regression cases"]);
  });

  test("deleting any cut blocking rule, or moving it out of the blocking list, is reported", () => {
    const cut = skillText("cut/SKILL.md");
    const rows = cut.split("\n");
    for (const rule of CUT_RULES) {
      const gap = [`Each of these is \`blocking\`: ${rule}`];
      expect(contractGaps("cut/SKILL.md", dropLine(cut, rule))).toEqual(gap);
      const line = rows.find((row) => row.includes(rule)) as string;
      expect(contractGaps("cut/SKILL.md", `${dropLine(cut, rule)}\n${line}\n`)).toEqual(gap);
    }
  });
});

describe("recipe in the skill text", () => {
  test("deleting a recipe Never rule, or moving it out of the Never list, is reported", () => {
    const recipe = skillText("recipe/SKILL.md");
    const rows = recipe.split("\n");
    for (const rule of RECIPE_NEVER) {
      const gap = [`## Never: ${rule}`];
      expect(contractGaps("recipe/SKILL.md", dropLine(recipe, rule.split(",")[0]))).toEqual(gap);
      const line = rows.find((row) => row.includes(rule.split(",")[0])) as string;
      expect(contractGaps("recipe/SKILL.md", `${dropLine(recipe, rule.split(",")[0])}\n${line}\n`)).toEqual(gap);
    }
  });

  test("dropping the design brief or the milestone size line from shaping is reported", () => {
    expect(contractGaps("recipe/references/shaping.md", skillText("recipe/references/shaping.md").replaceAll("## Design brief", "## Brief"))).toEqual(["## Design brief"]);
    expect(contractGaps("recipe/references/shaping.md", dropLine(skillText("recipe/references/shaping.md"), "Size: pour | distill | tap"))).toEqual(["Size: pour | distill | tap"]);
  });
});

describe("design loop in the skill text", () => {
  test("dropping the snapshot, the additive rule, or the Design section is reported", () => {
    const designing = skillText("distill/references/designing.md");
    expect(contractGaps("distill/references/designing.md", dropLine(designing, "never read the live"))).toEqual(["never read the live canvas"]);
    expect(contractGaps("distill/references/designing.md", dropLine(designing, "Never edit, move, resize, or delete"))).toEqual(["Never edit, move, resize, or delete an existing artboard"]);
    expect(contractGaps("distill/references/distilling.md", dropLine(skillText("distill/references/distilling.md"), "Design: <canvas link"))).toEqual(["line: Design: "]);
    expect(contractGaps("barrel/stages/pick.md", dropLine(skillText("barrel/stages/pick.md"), "Build to the snapshot"))).toEqual(["Build to the snapshot, never to the live canvas"]);
  });
});

describe("user guide and rack in the skill text", () => {
  test("deleting the user guide section from distilling or triage is reported", () => {
    // The heading line itself, not prose that mentions it.
    const dropHeading = (text: string): string => text.split("\n").filter((row) => row !== "## User guide").join("\n");
    expect(contractGaps("distill/references/distilling.md", dropHeading(skillText("distill/references/distilling.md")))).toEqual(["line: ## User guide"]);
    expect(contractGaps("tap/references/triage.md", dropHeading(skillText("tap/references/triage.md")))).toEqual(["line: ## User guide"]);
  });

  test("dropping the opt-out from distill is reported", () => {
    expect(contractGaps("distill/SKILL.md", skillText("distill/SKILL.md").replaceAll(GUIDE_OFF, "None"))).toEqual([GUIDE_OFF]);
  });

  test("rack exists and VENDORED.md names the SHA it last racked", () => {
    const rack = skillText("rack/SKILL.md");
    expect(rack).toMatch(/^---\nname: rack\n/);
    expect(flatten(rack)).toContain("VENDORED.md");
    expect(flatten(skillText("terreno-shared/VENDORED.md"))).toMatch(/Last racked from terreno .* at `[0-9a-f]{8,40}`/);
  });
});

// The README and the overview skill are how people and agents learn brewery, so a skill or
// command that ships without them fails here. See "Keep the docs and installer current" in CLAUDE.md.
const ROOT = join(import.meta.dir, "..", "..");
const rootText = (path: string): string => readFileSync(join(ROOT, path), "utf8");

const skillNames = (): string[] =>
  readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS_DIR, entry.name, "SKILL.md")))
    .map((entry) => entry.name);

const cliCommands = (): string[] => {
  const source = rootText("cli/src/cli.ts");
  const main = source.slice(source.indexOf("const main = async"));
  // `note` and `answer` are dispatched before the switch.
  const names = [...main.matchAll(/case "([a-z][a-z-]*)":|command === "([a-z][a-z-]*)"/g)].map((m) => m[1] ?? m[2]);
  return [...new Set(names)].filter((name) => name !== "help");
};

const MANIFESTS = [
  ".claude-plugin/marketplace.json",
  ".cursor-plugin/marketplace.json",
  "plugins/brewery/.claude-plugin/plugin.json",
  "plugins/brewery/.cursor-plugin/plugin.json",
  "plugins/brewery/.codex-plugin/plugin.json",
];

const manifestVersion = (path: string): string => {
  const json = JSON.parse(rootText(path)) as { version?: string; metadata?: { version?: string } };
  return json.version ?? json.metadata?.version ?? "missing";
};

const missingSkills = (text: string, names: string[]): string[] => names.filter((name) => !text.includes(`\`${name}\``));

describe("README, overview, and install stay current", () => {
  test("every skill has a frontmatter name matching its directory", () => {
    for (const name of skillNames()) expect(skillText(`${name}/SKILL.md`)).toMatch(new RegExp(`^---\\nname: ${name}\\n`));
  });

  test("every skill appears in the README, its Skills table, and the overview skill", () => {
    const names = skillNames();
    expect(names).toContain("install");
    expect(names).toContain("overview");
    const readme = rootText("README.md");
    expect(missingSkills(readme, names)).toEqual([]);
    const table = readme.slice(readme.indexOf("### Skills"), readme.indexOf("### CLI"));
    expect(names.filter((name) => !table.includes(`| \`${name}\` |`))).toEqual([]);
    expect(missingSkills(skillText("overview/SKILL.md"), names)).toEqual([]);
  });

  test("a skill missing from the README or overview is reported", () => {
    expect(missingSkills(rootText("README.md").replaceAll("`polish`", "polish"), skillNames())).toEqual(["polish"]);
    expect(missingSkills(skillText("overview/SKILL.md").replaceAll("`rack`", "rack"), skillNames())).toEqual(["rack"]);
  });

  test("every CLI command appears in HELP and the README", () => {
    const commands = cliCommands();
    expect(commands).toContain("board");
    expect(commands).toContain("note");
    expect(commands.length).toBeGreaterThan(10);
    const help = rootText("cli/src/cli.ts");
    const readme = rootText("README.md");
    expect(commands.filter((c) => !help.includes(`  brewery ${c}`))).toEqual([]);
    expect(commands.filter((c) => !readme.includes(`brewery ${c}`))).toEqual([]);
    expect(commands.filter((c) => !readme.replaceAll("brewery cellar", "cellar").includes(`brewery ${c}`))).toEqual(["cellar"]);
  });

  test("the install skill covers every install route the README gives", () => {
    const install = flatten(skillText("install/SKILL.md"));
    for (const step of ["bin/install", "brewery agents", "claude plugin install brewery@brewery", "codex plugin add brewery@brewery", "~/.cursor/plugins/local/", "notify.ntfyUrl", "brewery init-docs", "## Testing conventions", "## User guide conventions"]) {
      expect(install).toContain(step);
    }
  });

  test("the plugin manifests and marketplaces carry one version", () => {
    const versions = MANIFESTS.map(manifestVersion);
    expect(versions.every((v) => /^\d+\.\d+\.\d+$/.test(v))).toBe(true);
    expect(new Set(versions).size).toBe(1);
  });
});

describe("pipeline projection", () => {
  const building = (repo: string): RunState => {
    const state = newState({ slug: "greet", repo, ip: join(repo, "docs/plans/2026-10-12-greet.md"), base: "master", phase: "build" });
    state.branch = "greet";
    state.tasks = { T1: { status: "passed", attempts: 2, commit: "abc123" }, T2: { status: "todo", attempts: 1 } };
    const step = (stage: string, task: string, status: "PASS" | "FAIL"): RunState["history"][number] => ({
      seq: state.history.length + 1,
      stage,
      agent: "alpha",
      status,
      action: `${stage} ${status}`,
      seconds: 1,
      log: join(repo, ".terreno/brewery/greet/steps", `${stage}.log`),
      task,
    });
    state.history = [step("pick", "T1", "PASS"), step("roast", "T1", "FAIL"), step("pick", "T1", "PASS"), step("roast", "T1", "PASS"), step("pick", "T2", "PASS")];
    return state;
  };

  test("a run mid-build matches the execution-state schema", () => {
    const repo = tempRepo();
    const state = building(repo);
    const projected = projectPipeline(state);
    expect(violations(projected, schema())).toEqual([]);
    expect(projected).toMatchObject({ stage: "pick", task: "T2", attempt: 1, ip: "docs/plans/2026-10-12-greet.md", next: { stage: "pick", human: false } });
    expect(projected.ledger.map((l) => `${l.task}:${l.stage}:${l.attempt}:${l.status}`)).toEqual(["T1:pick:1:PASS", "T1:roast:1:FAIL", "T1:pick:2:PASS", "T1:roast:2:PASS", "T2:pick:1:PASS"]);
    expect(projected.ledger[0].sha).toBe("abc123");
  });

  test("waiting and done runs project the human and terminal next steps", () => {
    const repo = tempRepo();
    const waiting = building(repo);
    waiting.phase = "signoff";
    waiting.waiting = { kind: "signoff", asks: [], message: "Sign off on the IP\nmore", since: "2026-10-12T00:00:00Z" };
    expect(projectPipeline(waiting).next).toEqual({ stage: "grow", why: "Sign off on the IP", human: true });
    const done = building(repo);
    done.phase = "done";
    done.pr = 7;
    const projected = projectPipeline(done);
    expect(violations(projected, schema())).toEqual([]);
    expect(projected).toMatchObject({ stage: "taste", pr: "7", next: { stage: null, human: false } });
  });

  test("saveState writes the projection next to brewery's state", () => {
    const repo = tempRepo();
    fakeSetup(repo, []);
    saveState(building(repo));
    const written = JSON.parse(readFileSync(pipelinePath(repo, "greet"), "utf8"));
    expect(violations(written, schema())).toEqual([]);
  });
});

describe("scrub", () => {
  test("redacts identifiers and secrets but keeps ordinary log text", () => {
    const text = [
      "2026-10-12T03:00:01.1234567Z FAIL test/user.test.ts",
      "expected jane.doe@example.com to equal (555) 123-4567, ssn 123-45-6789",
      "dob 2001-04-05 or 4/5/2001, mrn 88812345",
      "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 Authorization: Bearer abc.def",
      "mongodb://app:hunter2@db.internal/flourish",
      "\x1b[31m  ✗ 3 failed\x1b[0m",
    ].join("\n");
    const out = scrub(text);
    expect(out).toContain("2026-10-12T03:00:01.1234567Z FAIL test/user.test.ts");
    for (const leaked of ["jane.doe", "123-4567", "123-45-6789", "2001-04-05", "4/5/2001", "88812345", "ghp_", "abc.def", "hunter2", "\x1b"]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain("✗ 3 failed");
  });

  test("keeps the tail, starting on a whole line", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const tail = scrubTail(text, 100);
    expect(tail.length).toBeLessThanOrEqual(100);
    expect(tail.endsWith("line 199")).toBe(true);
    expect(tail.startsWith("line ")).toBe(true);
  });
});

describe("CI evidence", () => {
  test("the excerpt drops gh's line prefix and the cleanup steps after the last error", () => {
    const raw = [
      "Test\tUNKNOWN STEP\t2026-10-12T21:21:08.9497222Z 1 tests failed:",
      "Test\tUNKNOWN STEP\t2026-10-12T21:21:08.9498329Z (fail) harness > delivers a PNG",
      "Test\tUNKNOWN STEP\t2026-10-12T21:21:08.9923434Z ##[error]Process completed with exit code 1.",
      "Test\tUNKNOWN STEP\t2026-10-12T21:21:09.2756679Z [command]/usr/bin/git config --local --unset includeif",
      "Test\tUNKNOWN STEP\t2026-10-12T21:21:09.3637655Z Cleaning up orphan processes",
    ].join("\n");
    expect(failureExcerpt(raw)).toBe("1 tests failed:\n(fail) harness > delivers a PNG\n##[error]Process completed with exit code 1.");
    expect(failureExcerpt("plain\nlog")).toBe("plain\nlog");
  });

  const snap = (sha: string, bucket: "pass" | "fail"): PrSnapshot => ({
    sha,
    mergeable: "MERGEABLE",
    mergeState: bucket === "pass" ? "CLEAN" : "UNSTABLE",
    checks: [{ name: "Unit Tests", bucket, link: "https://github.com/o/r/actions/runs/1/job/2" }],
  });

  test("finish records a scrubbed failure before Taste and the fixing sha once green", async () => {
    const repo = tempRepo();
    const { config } = fakeSetup(repo, [{ match: "taste", result: { status: "PASS", action: "fixed and pushed" } }]);
    const ctx = quietCtx(newState({ slug: "pr-7", repo, ip: "", base: "master", phase: "finish" }), config);
    const ci = fakeCi([snap("a", "fail"), snap("b", "pass"), snap("b", "pass")], 7, "FAIL user.test.ts: ops@flourish.health");
    expect(await finish(ctx, ci, 7)).toBe("done");
    const [{ file, failure }] = readFailures(ctx.state);
    expect(file).toEndWith("ci/001-unit-tests.json");
    expect(failure).toMatchObject({ check: "Unit Tests", pr: 7, sha: "a", status: "fixed", fixSha: "b", log: "FAIL user.test.ts: [email]" });
  });

  test("a check that goes green at the same sha is flaky, and repeats are recorded once", async () => {
    const repo = tempRepo();
    const { config } = fakeSetup(repo, [{ match: "taste", result: { status: "PASS", action: "reran" } }]);
    const ctx = quietCtx(newState({ slug: "pr-7", repo, ip: "", base: "master", phase: "finish" }), config);
    // finish sees the failure at "a" twice (each loop, plus a read after each Taste) before it passes at "a"
    const ci = fakeCi([snap("a", "fail"), snap("a", "fail"), snap("a", "fail"), snap("a", "pass")]);
    expect(await finish(ctx, ci, 7)).toBe("done");
    expect(ctx.state.history.filter((h) => h.stage === "taste")).toHaveLength(2);
    const failures = readFailures(ctx.state);
    expect(failures).toHaveLength(1);
    expect(failures[0].failure).toMatchObject({ status: "flaky" });
    expect(failures[0].failure.fixSha).toBeUndefined();
  });
});
