import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approveFromJson, claimedScope, evidenceInventory, findPlans, gatherContext, splitBody } from "../src/approve/context.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { ChangedFile, Ci, PrView } from "../src/vcs.ts";

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", "approve", name), "utf8");
const planDirs = DEFAULT_CONFIG.approve.planDirs;
const planText = fixture("plan-deploy-to-gcp.md");

const headFiles: Record<string, string> = {
  "docs/implementationPlans/deploy-to-gcp.md": planText,
  "docs/tasks/deploy-to-gcp.md": "# Tasks\n- 2.1 module\n- 2.2 service\n",
  "docs/plans/2026-10-01-post-cache.md": "# Post cache\n",
  "docs/implementationPlans/windowed-admin-sync.md": "# Windowed sync\n",
};
const readHead = async (path: string): Promise<string | null> => headFiles[path] ?? null;

describe("splitBody", () => {
  test("splits the attention-contract sections and parses the verification table", () => {
    const body = splitBody(fixture("body-inline.md"));
    expect(body.why).toContain("GCP story");
    expect(body.whatChanged).toContain("terraform/modules/terreno-backend");
    expect(body.verification).toEqual([
      { status: "tested", scope: "Module behavior and IAM scoping", evidence: "`terraform test` → 8 passed" },
      { status: "instructions", scope: "Preview no-op", evidence: "Open the `gcp-cd-preview` job log and confirm `Plan: 0 to add`" },
      { status: "notTested", scope: "Live apply to a scratch project", evidence: "Deferred per GC8" },
    ]);
    expect(body.stageResult).toEqual({ v: "2", stage: "brew", status: "PASS", ip: "deploy-to-gcp", sha: "775ed94aa1e0dd103a98f9965b93390bbd3db2c3", done: ["2.1 Roast PASS", "2.2 Roast PASS"], next: "taste", action: "Watch CI and review bots; react" });
  });

  test("a Check | Result table with the status mark in the result column parses as rows", () => {
    const body = "## Verification\n\n| Check | Result |\n| --- | --- |\n| `bun test` | ✅ 4 pass |\n| The model step | ⚠️ Not tested locally: no credential |\n| Plain prose row | nothing here |\n";
    expect(splitBody(body).verification).toEqual([
      { status: "tested", scope: "`bun test`", evidence: "✅ 4 pass" },
      { status: "notTested", scope: "The model step", evidence: "⚠️ Not tested locally: no credential" },
    ]);
  });

  test("a last-position Verification table and sections containing a capital Z parse", () => {
    const last = splitBody("## Why\nZero downtime deploy.\n\n## Verification\n| Status | Scope | Evidence |\n| --- | --- | --- |\n| ⚠️ Not tested | Live apply | Deferred |\n");
    expect(last.why).toBe("Zero downtime deploy.");
    expect(last.verification).toEqual([{ status: "notTested", scope: "Live apply", evidence: "Deferred" }]);
    expect(splitBody(fixture("body-link.md")).verification).toEqual([{ status: "tested", scope: "Cold start loads once", evidence: "`bun test apps/web/posts` → 4 passed" }]);
    expect(splitBody("## What changed\r\n- Zod schema\r\n\r\n## Why\r\nBecause.\r\n").whatChanged).toBe("- Zod schema");
  });

  test("a block-list stage result keeps top-level keys and scalar lists, not nested check fields", () => {
    const body = splitBody(
      "<details>\n<summary>Stage result</summary>\n\n```yaml\nv: 2\nstage: taste\nstatus: PASS\nip: 2026-10-01-post-cache\ndone:\n  - \"T1 Roast PASS\"\n  - T2 Roast PASS\nchecks:\n  - name: circleci\n    status: FAIL\n    ev: \"43 success\"\nnext: null\naction: Done\n```\n</details>\n",
    );
    expect(body.stageResult).toEqual({ v: "2", stage: "taste", status: "PASS", ip: "2026-10-01-post-cache", done: ["T1 Roast PASS", "T2 Roast PASS"], checks: [], next: "null", action: "Done" });
    expect(claimedScope(body)).toEqual(["T1", "T2"]);
  });

  test("a Verification section without status marks keeps its raw text", () => {
    const body = splitBody("## Verification\n\n- `bun test` → 4 pass\n\n## Notes\nx\n");
    expect(body.verification).toEqual([]);
    expect(body.verificationText).toBe("- `bun test` → 4 pass");
  });

  test("a body without the sections or a stage result still parses", () => {
    const body = splitBody("Just a sentence.");
    expect(body.why).toBe("");
    expect(body.whatChanged).toBe("");
    expect(body.verification).toEqual([]);
    expect(body.stageResult).toBeNull();
    expect(splitBody("").verification).toEqual([]);
  });
});

describe("claimedScope", () => {
  test("reads a task range from the body and the stage result's done list", () => {
    const body = splitBody(fixture("body-inline.md"));
    expect(claimedScope(body)).toEqual(["2.1", "2.2"]);
  });
  test("expands T ranges and lists", () => {
    expect(claimedScope(splitBody("Implements T1–T3 and T6."))).toEqual(["T1", "T2", "T3", "T6"]);
    expect(claimedScope(splitBody(fixture("body-details.md")))).toEqual(["T3", "T4"]);
  });
  test("no claim means an empty scope", () => {
    expect(claimedScope(splitBody(fixture("body-link.md")))).toEqual([]);
  });
});

describe("findPlans", () => {
  test("an inline IP reference, the stage-result slug, and the tasks sibling resolve once each", async () => {
    const plans = await findPlans({ body: splitBody(fixture("body-inline.md")), changed: [], planDirs, readHead });
    expect(plans.map((p) => p.path)).toEqual(["docs/implementationPlans/deploy-to-gcp.md", "docs/tasks/deploy-to-gcp.md"]);
    expect(plans[0].text).toBe(planText);
    expect(plans[0].editedInPr).toBe(false);
  });

  test("a markdown link under docs/plans resolves", async () => {
    const plans = await findPlans({ body: splitBody(fixture("body-link.md")), changed: [], planDirs, readHead });
    expect(plans.map((p) => p.path)).toEqual(["docs/plans/2026-10-01-post-cache.md"]);
  });

  test("a Details-block path resolves and a plan changed in the PR is flagged", async () => {
    const changed: ChangedFile[] = [{ path: "docs/implementationPlans/windowed-admin-sync.md", additions: 3, deletions: 1 }];
    const plans = await findPlans({ body: splitBody(fixture("body-details.md")), changed, planDirs, readHead });
    expect(plans).toEqual([{ path: "docs/implementationPlans/windowed-admin-sync.md", text: "# Windowed sync\n", editedInPr: true }]);
  });

  test("a changed plan file with no body reference is still found; a missing file is skipped", async () => {
    const changed: ChangedFile[] = [
      { path: "docs/plans/2026-10-01-post-cache.md", additions: 1, deletions: 0 },
      { path: "docs/plans/not-at-head.md", additions: 1, deletions: 0 },
    ];
    const plans = await findPlans({ body: splitBody("no refs"), changed, planDirs, readHead });
    expect(plans.map((p) => p.path)).toEqual(["docs/plans/2026-10-01-post-cache.md"]);
  });

  test("a bare stage-result slug resolves to a dated plan file through the head listing", async () => {
    const body = splitBody("<details>\n<summary>Stage result</summary>\n\n```yaml\nv: 2\nip: post-cache\n```\n</details>\n");
    const listHead = async (dir: string): Promise<string[]> => Object.keys(headFiles).filter((p) => p.startsWith(`${dir}/`));
    const plans = await findPlans({ body, changed: [], planDirs, readHead, listHead });
    expect(plans.map((p) => p.path)).toEqual(["docs/plans/2026-10-01-post-cache.md"]);
  });

  test("a body with nothing yields no plans", async () => {
    expect(await findPlans({ body: splitBody("hello"), changed: [], planDirs, readHead })).toEqual([]);
  });
});

describe("evidenceInventory", () => {
  test("collects images, videos, and test files in the diff", () => {
    const inventory = evidenceInventory(fixture("body-link.md"), [
      { path: "apps/web/posts.test.ts", additions: 10, deletions: 0 },
      { path: "apps/web/posts.ts", additions: 5, deletions: 2 },
    ], DEFAULT_CONFIG.approve.pathRules);
    expect(inventory.media).toEqual(["https://user-images.githubusercontent.com/1/cold.png", "https://gist.github.com/x/warm.gif"]);
    expect(inventory.testFiles).toEqual(["apps/web/posts.test.ts"]);
  });
});

describe("approveFromJson", () => {
  test("merges a base-branch .brewery.json over the defaults and tolerates a missing or bad file", () => {
    const merged = approveFromJson('{"approve": {"approveLevels": [], "maxFiles": 5}}');
    expect(merged.approveLevels).toEqual([]);
    expect(merged.maxFiles).toBe(5);
    expect(merged.pathRules).toEqual(DEFAULT_CONFIG.approve.pathRules);
    expect(approveFromJson(null)).toEqual(DEFAULT_CONFIG.approve);
    expect(approveFromJson("{not json")).toEqual(DEFAULT_CONFIG.approve);
  });
});

describe("gatherContext", () => {
  const view: PrView = {
    number: 42,
    title: "Deploy to GCP",
    body: fixture("body-inline.md"),
    author: "joshgachnang",
    authorIsBot: false,
    isDraft: false,
    labels: [],
    base: "master",
    headSha: "775ed94aa1e0dd103a98f9965b93390bbd3db2c3",
    reviews: [{ id: "PRR_1", author: "terreno-approve[bot]", state: "APPROVED", body: "<!-- terreno-approve:old -->", isBot: true }],
    checks: [{ name: "test", bucket: "pass" }],
    botThreads: [],
  };
  const files: ChangedFile[] = [{ path: "terraform/modules/x/main.tf", additions: 40, deletions: 0 }];
  const baseFiles: Record<string, string> = {
    ".brewery.json": '{"approve": {"approveLevels": ["low", "medium"]}}',
    "docs/approval-rubric.md": "# Our rubric\n",
  };
  const ci = {
    prView: async (): Promise<PrView> => view,
    prFiles: async (): Promise<ChangedFile[]> => files,
    prDiff: async (): Promise<string> => "diff --git a/terraform/modules/x/main.tf\n+resource\n",
  } as unknown as Ci;

  test("assembles policy from the base, context from the head, and the plan from the body", async () => {
    const ctx = await gatherContext({
      ci,
      repo: "/repo",
      pr: 42,
      planDirs,
      readBase: async (path) => baseFiles[path] ?? null,
      readHead,
      baseSha: async () => "abc123",
    });
    expect(ctx.pr.number).toBe(42);
    expect(ctx.policy.approve.approveLevels).toEqual(["low", "medium"]);
    expect(ctx.policy.rubric).toBe("# Our rubric\n");
    expect(ctx.policy.source).toBe("master@abc123");
    expect(ctx.scope).toEqual(["2.1", "2.2"]);
    expect(ctx.plans.map((p) => p.path)).toEqual(["docs/implementationPlans/deploy-to-gcp.md", "docs/tasks/deploy-to-gcp.md"]);
    expect(ctx.diff).toContain("+resource");
    expect(ctx.files).toEqual(files);
    expect(ctx.body.verification).toHaveLength(3);
  });

  test("a repo without a rubric file falls back to null so the shipped default is used", async () => {
    const ctx = await gatherContext({ ci, repo: "/repo", pr: 42, planDirs, readBase: async () => null, readHead, baseSha: async () => "abc123" });
    expect(ctx.policy.rubric).toBeNull();
    expect(ctx.policy.approve).toEqual(DEFAULT_CONFIG.approve);
  });
});
