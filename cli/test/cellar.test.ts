// brewery cellar <owner/name> against a temp repo with a bare origin and a fake GitHub.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cellar, countChanges } from "../src/commands/cellar.ts";
import { initDocs, RULES_PATH } from "../src/docs.ts";
import type { FailedRun, Forge, MergedPr, NewPr } from "../src/forge.ts";
import { fakeSetup, run, tempRepo } from "./helpers.ts";

const NAME = "acme/widgets";
const NOW = new Date("2026-10-12T03:00:00Z");

const fakeForge = (failed: FailedRun[], merged: MergedPr[], logs: Record<number, string> = {}): Forge & { prs: NewPr[] } => {
  const prs: NewPr[] = [];
  return {
    prs,
    failedRuns: async () => failed,
    runLog: async (_name, id) => logs[id] ?? "",
    mergedPrs: async () => merged,
    reviewedPrs: async () => [],
    createPr: async (_cwd, pr) => {
      prs.push(pr);
      return "https://github.com/acme/widgets/pull/42";
    },
    clone: async () => {
      throw new Error("should not clone");
    },
  };
};

const failure = (id: number, branch: string): FailedRun => ({
  id,
  workflow: "CI",
  branch,
  sha: `${id}`.padEnd(40, "0"),
  createdAt: `2026-10-11T0${id}:00:00Z`,
  url: `https://github.com/acme/widgets/actions/runs/${id}`,
});

// A repo with the docs layout and one journal on origin/master, mapped to acme/widgets.
const setup = (plan: unknown[], extraConfig: Record<string, unknown> = {}): { repo: string; origin: string } => {
  const repo = tempRepo();
  const origin = mkdtempSync(join(tmpdir(), "brewery-origin-"));
  run(origin, "git", "init", "-q", "--bare");
  run(repo, "git", "remote", "add", "origin", origin);
  initDocs(repo);
  writeFileSync(join(repo, "docs/journal/2026-10-11-greet.md"), "# Journal: Add greeting\n");
  run(repo, "git", "add", "-A");
  run(repo, "git", "commit", "-q", "-m", "Add docs layout and a journal");
  run(repo, "git", "push", "-q", "origin", "master");
  fakeSetup(repo, plan);
  const configPath = process.env.BREWERY_CONFIG as string;
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  writeFileSync(configPath, JSON.stringify({ ...config, ...extraConfig, repos: { [NAME]: repo } }));
  process.env.BREWERY_CELLAR_DIR = mkdtempSync(join(tmpdir(), "brewery-cellar-state-"));
  return { repo, origin };
};

const quiet = { now: NOW, log: () => {} };

const RULES_WITH = (...rules: string[]): string => `# Rules\n\n## Active\n\n${rules.map((r) => `- ${r}`).join("\n")}\n\n## Retired\n`;

describe("cellar", () => {
  test("turns evidence into one PR, pushes the branch, and stamps the pass", async () => {
    const { repo, origin } = setup([
      {
        match: "cellar",
        write: {
          "docs/learnings/ci/migrate-before-api-tests.md": "---\ntitle: Run migrations before API tests\n---\n",
          [RULES_PATH]: RULES_WITH("Run migrations before the API tests (docs/learnings/ci/migrate-before-api-tests.md)"),
        },
        result: { status: "PASS", action: "opened", summary: "API tests failed twice on missing migrations.", changes: ["Rule: run migrations first (runs 2, 3)"] },
      },
    ]);
    const forge = fakeForge([failure(2, "a"), failure(3, "b"), failure(4, "b")], [], { 2: "Error: relation users does not exist\nops@example.com", 3: "same", 4: "dup" });

    const outcome = await cellar(NAME, forge, quiet);

    expect(outcome).toEqual({ status: "pr", url: "https://github.com/acme/widgets/pull/42" });
    const [pr] = forge.prs;
    expect(pr).toMatchObject({ name: NAME, base: "master", head: "cellar-20261012-0300", title: "Record learnings from 2026-10-05 to 2026-10-12" });
    expect(pr.body).toContain("API tests failed twice on missing migrations.");
    expect(pr.body).toContain("- Rule: run migrations first (runs 2, 3)");
    expect(pr.body).toContain("1 journals, 3 failed CI runs, 0 merged PRs");
    expect(pr.body).not.toContain("Proposed brewery skill changes");
    expect(run(origin, "git", "show", "cellar-20261012-0300:docs/learnings/ci/migrate-before-api-tests.md")).toContain("Run migrations");

    const [prompt] = readdirSync(join(repo, ".terreno/brewery/cellar-20261012-0300/steps")).filter((f) => f.endsWith(".prompt.md"));
    const text = readFileSync(join(repo, ".terreno/brewery/cellar-20261012-0300/steps", prompt), "utf8");
    expect(text).toContain("- docs/journal/2026-10-11-greet.md");
    expect(text).toContain("### CI: 3 failed runs");
    expect(text).toContain("Error: relation users does not exist\n[email]");
    expect(text).toContain("dup"); // newest log per workflow and branch
    expect(text).not.toContain("~~~\nsame");
    expect(text).toContain("Learning mode for this repo: local.");

    expect(run(repo, "git", "worktree", "list")).not.toContain("brewery-cellar-tree");
    expect(run(repo, "git", "branch", "--list", "cellar-*")).toBe("");
    const stamp = JSON.parse(readFileSync(join(process.env.BREWERY_CELLAR_DIR as string, "acme__widgets.json"), "utf8"));
    expect(stamp.since).toBe(NOW.toISOString());
    expect(readFileSync(join(process.env.BREWERY_CELLAR_DIR as string, "cellar.log"), "utf8")).toContain("acme/widgets\tpr\thttps://github.com/acme/widgets/pull/42");
  });

  test("does nothing, and calls no agent, when nothing happened since the last pass", async () => {
    setup([]);
    const outcome = await cellar(NAME, fakeForge([], []), { ...quiet, since: "2099-01-01T00:00:00Z" });
    expect(outcome.status).toBe("nothing");
  });

  test("refuses to open a PR over the change limit and does not stamp", async () => {
    setup([
      {
        match: "cellar",
        write: { [RULES_PATH]: RULES_WITH("one", "two", "three"), "eslint.config.js": "export default [];\n" },
        result: { status: "PASS", action: "too much" },
      },
    ]);
    const forge = fakeForge([failure(2, "a")], []);
    expect((await cellar(NAME, forge, quiet)).status).toBe("too-many");
    expect(forge.prs).toHaveLength(0);
    expect(existsSync(join(process.env.BREWERY_CELLAR_DIR as string, "acme__widgets.json"))).toBe(false);
  });

  test("an agent that changes nothing opens no PR", async () => {
    setup([{ match: "cellar", result: { status: "PASS", action: "nothing", summary: "No recurring failures." } }]);
    const forge = fakeForge([], [{ number: 5, title: "Fix", branch: "fix", mergedAt: "2026-10-11T00:00:00Z", url: "u", author: "josh" }]);
    expect((await cellar(NAME, forge, quiet)).status).toBe("no-changes");
    expect(forge.prs).toHaveLength(0);
  });

  test("shared repos carry skill proposals into the PR; dry runs and learn: off call no agent", async () => {
    setup([
      { match: "cellar", write: { "docs/learnings/ci/x.md": "---\ntitle: x\n---\n" }, result: { status: "PASS", action: "ok", proposals: "Roast should run migrations." } },
    ], { learn: "shared" });
    const forge = fakeForge([failure(2, "a")], []);
    const dry = await cellar(NAME, forge, { ...quiet, dryRun: true });
    expect(dry.status).toBe("dry-run");
    expect(dry.evidence).toContain("### CI: 1 failed run");
    expect((await cellar(NAME, forge, quiet)).status).toBe("pr");
    expect(forge.prs[0].body).toContain("## Proposed brewery skill changes\n\nRoast should run migrations.");

    const off = setup([], { learn: "off" });
    expect(off.repo).toBeTruthy();
    expect((await cellar(NAME, fakeForge([failure(2, "a")], []), quiet)).status).toBe("off");
  });

  test("rejects a name that is not owner/name", async () => {
    await expect(cellar("widgets", fakeForge([], []), quiet)).rejects.toThrow("want owner/name");
  });

  test("counts new Active rules and non-learning files, not learnings", () => {
    expect(countChanges(["- a"], ["- a", "- b"], [RULES_PATH, "docs/learnings/ci/x.md", "eslint.config.js"])).toBe(2);
    expect(countChanges([], [], ["docs/learnings/TEMPLATE.md"])).toBe(1);
  });
});

