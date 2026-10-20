import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, FAN_OUT, loadConfig, STAGES } from "../src/config.ts";
import { classify, decide, mergeLevel, type Gates } from "../src/approve/policy.ts";

const rules = DEFAULT_CONFIG.approve.pathRules;

const okGates: Gates = { checks: "pass", botThreads: 0, humanChangesRequested: false, size: "ok" };

describe("approve config", () => {
  test("ships defaults and an approve stage that fans out", () => {
    expect(DEFAULT_CONFIG.approve.approveLevels).toEqual(["low"]);
    expect(DEFAULT_CONFIG.approve.rubric).toBe("docs/approval-rubric.md");
    expect(DEFAULT_CONFIG.approve.planDirs).toEqual(["docs/implementationPlans", "docs/plans", "docs/tasks"]);
    expect(DEFAULT_CONFIG.approve.maxLines).toBe(800);
    expect(DEFAULT_CONFIG.approve.maxFiles).toBe(40);
    expect(STAGES).toContain("approve");
    expect(FAN_OUT.has("approve")).toBe(true);
    expect(DEFAULT_CONFIG.stages.approve).toEqual(["claude"]);
  });

  test("a repo's approve block merges field by field and replaces pathRules wholesale", () => {
    const dir = mkdtempSync(join(tmpdir(), "terreno-approve-config-"));
    writeFileSync(
      join(dir, ".brewery.json"),
      JSON.stringify({ approve: { approveLevels: [], pathRules: [{ match: ["src/**"], category: "source", floor: "medium" }] } }),
    );
    process.env.BREWERY_CONFIG = join(dir, "missing-user-config.json");
    const config = loadConfig(dir);
    expect(config.approve.approveLevels).toEqual([]);
    expect(config.approve.rubric).toBe("docs/approval-rubric.md");
    expect(config.approve.pathRules).toEqual([{ match: ["src/**"], category: "source", floor: "medium" }]);
  });
});

describe("classify", () => {
  test("docs-only change has a low ceiling and no floor", () => {
    const c = classify(["docs/approve.md", "README.md"], rules);
    expect(c.ceiling).toBe("low");
    expect(c.floor).toBeNull();
    expect(c.categories).toEqual(["docs"]);
    expect(c.never).toEqual([]);
  });

  test("tests and snapshots only has a low ceiling", () => {
    const c = classify(["cli/test/unit.test.ts", "app/__snapshots__/Home.test.tsx.snap", "e2e/login.spec.ts"], rules);
    expect(c.ceiling).toBe("low");
    expect(c.categories).toEqual(["tests"]);
  });

  test("docs plus source has no ceiling", () => {
    const c = classify(["docs/approve.md", "cli/src/approve/policy.ts"], rules);
    expect(c.ceiling).toBeNull();
    expect(c.categories).toEqual(["docs", "source"]);
  });

  test("an auth file sets a high floor even beside docs", () => {
    const c = classify(["backend/src/auth/session.ts", "docs/auth.md"], rules);
    expect(c.floor).toBe("high");
    expect(c.ceiling).toBeNull();
    expect(c.categories).toEqual(["auth", "docs"]);
  });

  test("the highest floor of any file wins", () => {
    const c = classify(["package.json", "terraform/main.tf"], rules);
    expect(c.floor).toBe("high");
    expect(c.categories).toEqual(["deps", "infra"]);
  });

  test("policy and CI files are never approvable", () => {
    const c = classify([".brewery.json", ".circleci/config.yml", "docs/approval-rubric.md", "src/a.ts"], rules);
    expect(c.never).toEqual([".brewery.json", ".circleci/config.yml", "docs/approval-rubric.md"]);
  });

  test("an empty diff has nothing to say", () => {
    const c = classify([], rules);
    expect(c).toEqual({ categories: [], floor: null, ceiling: null, never: [] });
  });
});

describe("mergeLevel", () => {
  test("the model cannot go below the floor", () => {
    expect(mergeLevel("low", "medium", null)).toBe("medium");
    expect(mergeLevel("high", "medium", null)).toBe("high");
  });
  test("the ceiling caps the model", () => {
    expect(mergeLevel("medium", null, "low")).toBe("low");
    expect(mergeLevel("low", null, "low")).toBe("low");
  });
  test("a floor above the ceiling wins", () => {
    expect(mergeLevel("low", "high", "low")).toBe("high");
  });
  test("no bounds means the model's level", () => {
    expect(mergeLevel("medium", null, null)).toBe("medium");
  });
});

describe("decide", () => {
  test("approves a low level with clean gates and no blocking finding", () => {
    const d = decide({ level: "low", approveLevels: ["low"], gates: okGates, blocking: 0, never: [] });
    expect(d.approve).toBe(true);
    expect(d.reasons).toEqual([]);
  });

  test("a level outside approveLevels is not approved and says so", () => {
    const d = decide({ level: "medium", approveLevels: ["low"], gates: okGates, blocking: 0, never: [] });
    expect(d.approve).toBe(false);
    expect(d.reasons).toEqual(["risk medium is above the configured approval levels (low)"]);
  });

  test("an empty approveLevels never approves", () => {
    const d = decide({ level: "low", approveLevels: [], gates: okGates, blocking: 0, never: [] });
    expect(d.approve).toBe(false);
    expect(d.reasons[0]).toContain("approveLevels is empty");
  });

  test("a blocking finding blocks at any level", () => {
    const d = decide({ level: "low", approveLevels: ["low"], gates: okGates, blocking: 2, never: [] });
    expect(d.approve).toBe(false);
    expect(d.reasons).toEqual(["2 blocking findings"]);
  });

  test("every failed gate is named", () => {
    const d = decide({
      level: "low",
      approveLevels: ["low"],
      gates: { checks: "fail", botThreads: 3, humanChangesRequested: true, size: "over" },
      blocking: 0,
      never: [".brewery.json"],
    });
    expect(d.approve).toBe(false);
    expect(d.reasons).toEqual([
      "checks on this head are failing",
      "3 unresolved bot review threads",
      "a human requested changes",
      "diff is over the size limit",
      "policy files changed: .brewery.json",
    ]);
  });

  test("pending checks block approval without failing it", () => {
    const d = decide({ level: "low", approveLevels: ["low"], gates: { ...okGates, checks: "pending" }, blocking: 0, never: [] });
    expect(d.approve).toBe(false);
    expect(d.reasons).toEqual(["checks on this head are still pending"]);
  });
});
