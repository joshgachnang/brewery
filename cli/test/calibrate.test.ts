// brewery calibrate <owner/name> against a temp repo with a bare origin and a fake GitHub.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calibrate, countChanges, renderEvidence, selectPrs } from "../src/commands/calibrate.ts";
import { initDocs } from "../src/docs.ts";
import type { Forge, NewPr, ReviewedPr } from "../src/forge.ts";
import { fakeSetup, run, tempRepo } from "./helpers.ts";

const NAME = "acme/widgets";
const NOW = new Date("2026-10-20T03:00:00Z");
const RUBRIC = "# Approval rubric\n\n## Levels\n\n- low: docs\n\n## Blocking findings\n\n- a visible bug\n";

const fakeForge = (reviewed: ReviewedPr[]): Forge & { prs: NewPr[] } => {
  const prs: NewPr[] = [];
  return {
    prs,
    failedRuns: async () => [],
    runLog: async () => "",
    mergedPrs: async () => [],
    reviewedPrs: async () => reviewed,
    createPr: async (_cwd, pr) => {
      prs.push(pr);
      return "https://github.com/acme/widgets/pull/77";
    },
    clone: async () => {
      throw new Error("should not clone");
    },
  };
};

const pr = (number: number, notes: ReviewedPr["notes"], over: Partial<ReviewedPr> = {}): ReviewedPr => ({
  number,
  title: `Change ${number}`,
  url: `https://github.com/acme/widgets/pull/${number}`,
  author: "dev",
  state: "merged",
  updatedAt: "2026-10-18T10:00:00Z",
  notes,
  ...over,
});

const human = (body: string, over: Partial<ReviewedPr["notes"][number]> = {}): ReviewedPr["notes"][number] => ({ kind: "comment", author: "josh", isBot: false, body, at: "2026-10-18T09:00:00Z", ...over });

const setup = (plan: unknown[]): { repo: string; origin: string } => {
  const repo = tempRepo();
  const origin = mkdtempSync(join(tmpdir(), "brewery-origin-"));
  run(origin, "git", "init", "-q", "--bare");
  run(repo, "git", "remote", "add", "origin", origin);
  initDocs(repo);
  writeFileSync(join(repo, "docs/approval-rubric.md"), RUBRIC);
  run(repo, "git", "add", "-A");
  run(repo, "git", "commit", "-q", "-m", "Add docs layout and a rubric");
  run(repo, "git", "push", "-q", "origin", "master");
  fakeSetup(repo, plan);
  const configPath = process.env.BREWERY_CONFIG as string;
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  writeFileSync(configPath, JSON.stringify({ ...config, repos: { [NAME]: repo } }));
  process.env.BREWERY_CELLAR_DIR = mkdtempSync(join(tmpdir(), "brewery-calibrate-state-"));
  return { repo, origin };
};

const quiet = { now: NOW, log: () => {} };

describe("calibrate", () => {
  test("selects PRs with human words, keeps the approver's verdict beside them, and renders evidence", () => {
    const reviewed = [
      pr(1, [
        { kind: "review", author: "terreno-approval-agent[bot]", isBot: true, state: "COMMENTED", body: "<!-- terreno-approve:abc -->\n**Risk: low — not approved.** approveLevels is empty\n", at: "2026-10-18T08:00:00Z" },
        human("Needs a test for the error path", { kind: "inline", path: "src/x.ts", line: 12, hunk: "+  throw new Error('x')" }),
        human("", { kind: "review", state: "CHANGES_REQUESTED" }),
        { kind: "comment", author: "cursor[bot]", isBot: true, body: "Bugbot found nothing", at: "2026-10-18T08:30:00Z" },
      ]),
      pr(2, [{ kind: "comment", author: "cursor[bot]", isBot: true, body: "bot only", at: "2026-10-18T08:30:00Z" }]),
      pr(3, [human("lgtm", { author: "sam" })]),
    ];
    const all = selectPrs(reviewed, []);
    expect(all.map((s) => s.pr.number)).toEqual([1, 3]);
    expect(selectPrs(reviewed, ["josh"]).map((s) => s.pr.number)).toEqual([1]);
    const text = renderEvidence(NAME, "2026-10-01", all, "Always ask for a changelog fragment.");
    expect(text).toContain("## #1 Change 1 (merged, by @dev)");
    expect(text).toContain("Human verdicts: @josh CHANGES_REQUESTED");
    expect(text).toContain("Approval agent said: **Risk: low — not approved.**");
    expect(text).toContain("- @josh on `src/x.ts:12`: Needs a test for the error path");
    expect(text).toContain("throw new Error('x')");
    expect(text).not.toContain("Bugbot found nothing");
    expect(text).toContain("## Notes from the human");
    expect(text).toContain("Always ask for a changelog fragment.");
  });

  test("counts new rubric bullets and flags files outside the allowed set", () => {
    const after = `${RUBRIC}- a migration without a rollback note\n- a second one\n`;
    expect(countChanges(RUBRIC, after, ["docs/approval-rubric.md", ".brewery.json", "docs/learnings/review/tests.md"], "docs/approval-rubric.md")).toEqual({ rules: 2, disallowed: [] });
    expect(countChanges(RUBRIC, RUBRIC, ["src/app.ts"], "docs/approval-rubric.md").disallowed).toEqual(["src/app.ts"]);
  });

  test("turns human comments into one rubric PR with proposals, and stamps the pass", async () => {
    const { repo, origin } = setup([
      {
        match: "calibrate",
        write: { "docs/approval-rubric.md": `${RUBRIC}- new logic without a test for its error path is never low (#1, @josh)\n` },
        result: {
          status: "PASS",
          action: "opened",
          summary: "Reviewers keep asking for error-path tests.",
          changes: ["Rubric: error-path test required (#1, @josh)"],
          proposals: "- Error paths of new logic need a test.",
        },
      },
    ]);
    const forge = fakeForge([pr(1, [human("Needs a test for the error path", { kind: "inline", path: "src/x.ts", line: 12 })])]);

    const outcome = await calibrate(NAME, forge, { ...quiet, notes: "Changelog fragments are not optional." });

    expect(outcome).toEqual({ status: "pr", url: "https://github.com/acme/widgets/pull/77" });
    const [opened] = forge.prs;
    expect(opened).toMatchObject({ name: NAME, base: "master", head: "calibrate-20261020-0300", title: "Calibrate the approval rubric from reviews 2026-09-20 to 2026-10-20" });
    expect(opened.body).toContain("Reviewers keep asking for error-path tests.");
    expect(opened.body).toContain("- Rubric: error-path test required (#1, @josh)");
    expect(opened.body).toContain("## Proposed lines for brewery's default rubric");
    expect(opened.body).toContain("1 PRs with 1 human comments, plus pasted notes");
    expect(run(origin, "git", "show", "calibrate-20261020-0300:docs/approval-rubric.md")).toContain("never low (#1, @josh)");

    const steps = join(repo, ".terreno/brewery/calibrate-20261020-0300/steps");
    const [prompt] = readdirSync(steps).filter((f) => f.endsWith(".prompt.md"));
    const text = readFileSync(join(steps, prompt), "utf8");
    expect(text).toContain("calibrate/SKILL.md");
    expect(text).toContain("Needs a test for the error path");
    expect(text).toContain("Changelog fragments are not optional.");
    const stamp = JSON.parse(readFileSync(join(process.env.BREWERY_CELLAR_DIR as string, "calibrate__acme__widgets.json"), "utf8"));
    expect(stamp.since).toBe(NOW.toISOString());
  });

  test("a change outside the rubric, .brewery.json, and learnings means no PR", async () => {
    setup([{ match: "calibrate", write: { "src/app.ts": "oops" }, result: { status: "PASS", action: "x", summary: "s" } }]);
    const forge = fakeForge([pr(1, [human("Use the generated SDK")])]);
    const outcome = await calibrate(NAME, forge, quiet);
    expect(outcome.status).toBe("disallowed");
    expect(outcome.detail).toBe("src/app.ts");
    expect(forge.prs).toHaveLength(0);
  });

  test("nothing to read means no agent and a moved stamp; dry-run prints evidence and moves nothing", async () => {
    setup([]);
    expect((await calibrate(NAME, fakeForge([]), quiet)).status).toBe("nothing");
    const lines: string[] = [];
    const out = await calibrate(NAME, fakeForge([pr(5, [human("Why is this file in the diff?")])]), { now: NOW, dryRun: true, log: (l) => lines.push(l) });
    expect(out.status).toBe("dry-run");
    expect(lines.join("\n")).toContain("Why is this file in the diff?");
  });
});
