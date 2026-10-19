import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";

const root = join(import.meta.dir, "..", "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

describe("approve docs and CI templates", () => {
  test("docs/approve.md documents every approve config key and the App's permissions", () => {
    const doc = read("docs/approve.md");
    for (const key of Object.keys(DEFAULT_CONFIG.approve)) expect(doc).toContain(`\`${key}\``);
    for (const rule of DEFAULT_CONFIG.approve.pathRules) expect(doc).toContain(rule.category);
    for (const env of ["BREWERY_APP_ID", "BREWERY_APP_PRIVATE_KEY", "BREWERY_APP_SLUG", "BREWERY_APP_INSTALLATION_ID", "BREWERY_APPROVE_TOKEN", "ANTHROPIC_API_KEY"]) {
      expect(doc).toContain(env);
    }
    for (const permission of ["Pull requests", "Checks", "Contents", "Metadata"]) expect(doc).toContain(permission);
    expect(doc).toContain("brewery/approve");
    expect(doc).toContain("--dry-run");
  });

  test("the CircleCI job parses, runs the command, halts outside PRs, and never fails the pipeline on a verdict", () => {
    const text = read("templates/ci/circleci-approve.yml");
    const parsed = Bun.YAML.parse(text) as { version: number; jobs: { approve: { steps: unknown[] } } };
    expect(parsed.version).toBe(2.1);
    expect(parsed.jobs.approve.steps.length).toBeGreaterThan(3);
    expect(text).toContain("cli/src/cli.ts\" approve");
    expect(text).toContain("CIRCLE_PULL_REQUEST");
    expect(text).toContain("circleci-agent step halt");
    expect(text).toContain("|| echo");
  });

  test("the GitHub workflow parses, uses pull_request_target with the base checked out, and read-only permissions", () => {
    const text = read("templates/ci/github-approve.yml");
    const parsed = Bun.YAML.parse(text) as { on: Record<string, unknown>; permissions: Record<string, string>; jobs: { approve: { steps: { run?: string; with?: Record<string, string> }[] } } };
    expect(Object.keys(parsed.on)).toEqual(["pull_request_target"]);
    expect(parsed.permissions).toEqual({ contents: "read", "pull-requests": "read", checks: "read" });
    const checkout = parsed.jobs.approve.steps.find((s) => s.with?.ref);
    expect(checkout?.with?.ref).toBe("${{ github.event.pull_request.base.sha }}");
    expect(parsed.jobs.approve.steps.some((s) => s.run?.includes("pull/${{ github.event.pull_request.number }}/head:pr-head"))).toBe(true);
    expect(parsed.jobs.approve.steps.some((s) => s.run?.includes("approve \"${{ github.event.pull_request.number }}\""))).toBe(true);
    expect(text).toContain("continue-on-error: true");
  });

  test("the READMEs point at the approve docs", () => {
    expect(read("README.md")).toContain("docs/approve.md");
    expect(read("cli/README.md")).toContain("docs/approve.md");
  });
});
