// The docs layout, the terreno pipeline projection, and CI failure evidence.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failureExcerpt, readFailures } from "../src/ci.ts";
import { finish } from "../src/commands/finish.ts";
import { initDocs, RULES_PATH } from "../src/docs.ts";
import { pipelinePath, projectPipeline } from "../src/pipeline.ts";
import { scrub, scrubTail } from "../src/scrub.ts";
import { newState, saveState, type RunState } from "../src/state.ts";
import type { PrSnapshot } from "../src/vcs.ts";
import { fakeCi, fakeSetup, quietCtx, tempRepo } from "./helpers.ts";

const SCHEMA_DIR = join(import.meta.dir, "..", "..", "plugins", "brewery", "skills", "terreno-shared");

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
