// End of run: the compound step, the journal commit and push, and learned rules in prompts.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { barrel } from "../src/commands/barrel.ts";
import { initDocs, RULES_PATH } from "../src/docs.ts";
import { renderJournal } from "../src/journal.ts";
import { struggles } from "../src/learn.ts";
import { newState, runDir } from "../src/state.ts";
import type { PrSnapshot } from "../src/vcs.ts";
import { fakeCi, fakeSetup, IP, quietCtx, run, tempRepo } from "./helpers.ts";

const green = (sha: string): PrSnapshot => ({ sha, mergeable: "MERGEABLE", mergeState: "CLEAN", checks: [{ name: "test", bucket: "pass" }] });

const LEARNING = `---
title: Spell the greeting exactly
category: testing
---

## Problem
`;

const BUILD_WITH_RETRY = [
  { match: "pick T1", times: 1, write: { "greeting.txt": "helo\n" }, result: { status: "PASS", action: "built" } },
  { match: "roast T1", times: 1, result: { status: "FAIL", action: "fix typo", fail: [{ need: "says hello", want: "hello", got: "helo", ev: "cat greeting.txt" }] } },
  { match: "pick T1", times: 1, write: { "greeting.txt": "hello\n" }, result: { status: "PASS", action: "fixed" } },
  { match: "roast T1", result: { status: "PASS", action: "proven" } },
];

const BUILD_CLEAN = [
  { match: "pick T1", write: { "greeting.txt": "hello\n" }, result: { status: "PASS", action: "built" } },
  { match: "roast T1", result: { status: "PASS", action: "proven" } },
];

const REST = [
  { match: "pick T2", write: { "farewell.txt": "bye\n" }, result: { status: "PASS", action: "built" } },
  { match: "roast T2", result: { status: "PASS", action: "proven" } },
  { match: "roast INTEGRATE", result: { status: "PASS", action: "combined tree proven" } },
  { match: "branch review", result: { status: "PASS", action: "reviewed", findings: [] } },
  { match: "brew", result: { status: "PASS", action: "opened", pr: 7 } },
];

// A repo with the docs layout, one active rule, an approved IP, and a bare origin.
const setup = (plan: unknown[]): { repo: string; origin: string; ctx: ReturnType<typeof quietCtx> } => {
  const repo = tempRepo();
  const origin = mkdtempSync(join(tmpdir(), "brewery-origin-"));
  run(origin, "git", "init", "-q", "--bare");
  run(repo, "git", "remote", "add", "origin", origin);
  initDocs(repo);
  writeFileSync(join(repo, RULES_PATH), "# Rules\n\n## Active\n\n- Run the greeting check before PASS.\n\n## Retired\n");
  mkdirSync(join(repo, "docs/plans"), { recursive: true });
  writeFileSync(join(repo, "docs/plans/greet.md"), IP("approved 2026-10-12"));
  run(repo, "git", "add", "-A");
  run(repo, "git", "commit", "-q", "-m", "Add docs layout");
  const { config } = fakeSetup(repo, plan);
  const state = newState({ slug: "greet", repo, ip: join(repo, "docs/plans/greet.md"), base: "master", phase: "approved" });
  return { repo, origin, ctx: quietCtx(state, config) };
};

const prompts = (repo: string, pattern: RegExp): string[] => {
  const dir = join(runDir(repo, "greet"), "steps");
  return readdirSync(dir)
    .filter((f) => pattern.test(f) && f.endsWith(".prompt.md"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"));
};

const journalFile = (repo: string): string => {
  const [name] = readdirSync(join(repo, "docs/journal")).filter((f) => f.endsWith("-greet.md"));
  return join(repo, "docs/journal", name);
};

describe("end of run", () => {
  test("a run that struggled commits one learning and the journal, pushes, and reverts stray edits", async () => {
    const { repo, origin, ctx } = setup([
      ...BUILD_WITH_RETRY,
      ...REST,
      {
        match: "compound",
        write: { "docs/learnings/testing/spell-greeting.md": LEARNING, "notes.txt": "scratch\n", [RULES_PATH]: "# Rules\n\n## Active\n\n- Agent rewrote this.\n" },
        result: { status: "PASS", action: "recorded", learning: "docs/learnings/testing/spell-greeting.md" },
      },
    ]);

    expect(await barrel(ctx, fakeCi([green("abc")]))).toBe("done");

    expect(run(repo, "git", "log", "-1", "--format=%s")).toBe("Add run journal with a learning for greet");
    expect(run(repo, "git", "status", "--porcelain")).toBe("");
    expect(run(origin, "git", "rev-parse", "greet")).toBe(run(repo, "git", "rev-parse", "HEAD"));
    expect(run(repo, "git", "show", "HEAD:docs/learnings/testing/spell-greeting.md")).toContain("Spell the greeting exactly");
    expect(existsSync(join(repo, "notes.txt"))).toBe(false);
    expect(readFileSync(join(repo, RULES_PATH), "utf8")).toContain("Run the greeting check before PASS.");

    const journal = readFileSync(journalFile(repo), "utf8");
    expect(journal).toStartWith("# Journal: Add greeting");
    expect(journal).toContain("| T1 | passed | 2 |");
    expect(journal).toContain("- Learning: [docs/learnings/testing/spell-greeting.md]");
    expect(journal).toContain("| roast T1 | beta | FAIL |");
    expect(journal).not.toContain(repo);

    const [compound] = prompts(repo, /-compound-/);
    expect(compound).toContain("roast (beta) FAILED: fix typo");
    expect(compound).toContain("says hello: got helo (cat greeting.txt)");
    for (const p of [...prompts(repo, /-pick-T1-/), compound]) expect(p).toContain("- Run the greeting check before PASS.");
    expect(ctx.state.history.filter((h) => h.stage === "compound")).toHaveLength(1);
  });

  test("a clean run skips compound and still commits the journal", async () => {
    const { repo, ctx } = setup([...BUILD_CLEAN, ...REST]);
    expect(await barrel(ctx, fakeCi([green("abc")]))).toBe("done");
    expect(ctx.state.history.some((h) => h.stage === "compound")).toBe(false);
    expect(run(repo, "git", "log", "-1", "--format=%s")).toBe("Add run journal for greet");
  });

  test("learn: off skips compound even when the run struggled", async () => {
    const { repo, ctx } = setup([...BUILD_WITH_RETRY, ...REST]);
    ctx.config.learn = "off";
    expect(await barrel(ctx, fakeCi([green("abc")]))).toBe("done");
    expect(ctx.state.history.some((h) => h.stage === "compound")).toBe(false);
    expect(run(repo, "git", "log", "-1", "--format=%s")).toBe("Add run journal for greet");
  });

  test("more than one learning keeps none", async () => {
    const { repo, ctx } = setup([
      ...BUILD_WITH_RETRY,
      ...REST,
      { match: "compound", write: { "docs/learnings/testing/a.md": LEARNING, "docs/learnings/ci/b.md": LEARNING }, result: { status: "PASS", action: "two", learning: "docs/learnings/testing/a.md" } },
    ]);
    expect(await barrel(ctx, fakeCi([green("abc")]))).toBe("done");
    expect(run(repo, "git", "log", "-1", "--format=%s")).toBe("Add run journal for greet");
    expect(existsSync(join(repo, "docs/learnings/testing/a.md"))).toBe(false);
    expect(existsSync(join(repo, "docs/learnings/ci/b.md"))).toBe(false);
  });

  test("a failed push leaves the journal uncommitted and still finishes", async () => {
    const { repo, ctx } = setup([...BUILD_CLEAN, ...REST]);
    run(repo, "git", "remote", "remove", "origin");
    expect(await barrel(ctx, fakeCi([green("abc")]))).toBe("done");
    expect(run(repo, "git", "log", "-1", "--format=%s")).toBe("Add farewell file");
    expect(run(repo, "git", "status", "--porcelain")).toContain("docs/journal/");
  });
});

describe("struggles", () => {
  test("is empty for a clean run and names corrections, not plain approvals", () => {
    const state = newState({ slug: "s", repo: tempRepo(), ip: "", base: "master", phase: "done" });
    state.tasks = { T1: { status: "passed", attempts: 1 } };
    state.answers = [{ q: "Sign off?", a: "ok", at: "2026-10-12T00:00:00Z" }];
    expect(struggles(state)).toBe("");
    state.answers.push({ q: "T1 is stuck", a: "retry: use the fixture user, not a new one", at: "2026-10-12T01:00:00Z" });
    expect(struggles(state)).toContain("A: retry: use the fixture user, not a new one");
    expect(struggles(state)).not.toContain("A: ok");
  });

  test("a PHI repo's journal keeps CI log tails out", async () => {
    const { mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
    const state = newState({ slug: "pr-9", repo: tempRepo(), ip: "", base: "master", phase: "done" });
    const ci = join(runDir(state.repo, state.slug), "ci");
    mk(ci, { recursive: true });
    wf(join(ci, "001-test.json"), JSON.stringify({ check: "test", sha: "a".repeat(40), at: "", log: "FAIL patient record", status: "fixed", fixSha: "b".repeat(40) }));
    expect(renderJournal(state)).toContain("FAIL patient record");
    const phi = renderJournal(state, null, [], true);
    expect(phi).not.toContain("FAIL patient record");
    expect(phi).toContain("Log kept out of the repo (PHI)");
  });

  test("the journal renders without history or an IP", () => {
    const state = newState({ slug: "pr-9", repo: tempRepo(), ip: "", base: "master", phase: "finish" });
    expect(renderJournal(state)).toBe("# Journal: pr-9\n\n- Run: `pr-9`\n- Agent time: 0m00s over 0 steps\n");
  });
});

describe("durable decisions", () => {
  const ipWithDecisions = `${IP("approved 2026-10-12")}
## Decisions

| ID | Question asked | Answer | What it changes |
| --- | --- | --- | --- |
| D1 | Plain text or markdown? | Plain text | T1 writes .txt |
| D2 (durable) | Where do greetings live? | Greetings live in the repo root, never in src/ | All tasks |
`;

  test("copies durable rows to numbered decision files and links them from the IP, once", async () => {
    const { promoteDecisions } = await import("../src/decisions.ts");
    const repo = tempRepo();
    initDocs(repo);
    writeFileSync(join(repo, "docs/decisions/0001-earlier.md"), "# 0001 — earlier\n");
    mkdirSync(join(repo, "docs/plans"), { recursive: true });
    const ip = join(repo, "docs/plans/2026-10-12-greet.md");
    writeFileSync(ip, ipWithDecisions);

    expect(promoteDecisions(repo, ip, new Date("2026-10-12T12:00:00Z"))).toEqual(["docs/decisions/0002-greetings-live-in-the-repo-root.md"]);
    const decision = readFileSync(join(repo, "docs/decisions/0002-greetings-live-in-the-repo-root.md"), "utf8");
    expect(decision).toStartWith("# 0002 — Greetings live in the repo root, never in src/\n\nDate: 2026-10-12\nStatus: accepted\nPlan: [docs/plans/2026-10-12-greet.md](../../docs/plans/2026-10-12-greet.md) (D2)");
    expect(decision).toContain("## Context\n\nWhere do greetings live?");
    const updated = readFileSync(ip, "utf8");
    expect(updated).toContain("| D2 (durable: [0002](../decisions/0002-greetings-live-in-the-repo-root.md)) |");
    expect(updated).toContain("| D1 | Plain text or markdown? |");
    expect(promoteDecisions(repo, ip)).toEqual([]);
  });

  test("the end-of-run commit carries promoted decisions", async () => {
    const { repo, ctx } = setup([...BUILD_CLEAN, ...REST]);
    writeFileSync(ctx.state.ip, ipWithDecisions);
    run(repo, "git", "commit", "-qam", "Add decisions");
    expect(await barrel(ctx, fakeCi([green("abc")]))).toBe("done");
    expect(run(repo, "git", "log", "-1", "--format=%s")).toBe("Add run journal with 1 decision for greet");
    expect(run(repo, "git", "show", "--name-only", "--format=", "HEAD")).toContain("docs/decisions/0001-greetings-live-in-the-repo-root.md");
    expect(readFileSync(journalFile(repo), "utf8")).toContain("- Decision: [docs/decisions/0001-greetings-live-in-the-repo-root.md]");
  });
});
