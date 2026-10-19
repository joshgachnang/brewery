import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { loadConfig } from "../src/config.ts";
import type { RunState } from "../src/state.ts";
import type { Ctx } from "../src/step.ts";
import type { Ci, PrSnapshot } from "../src/vcs.ts";

const FAKE = join(import.meta.dir, "fixtures", "fake-agent.ts");

export const run = (cwd: string, ...argv: string[]): string => {
  const res = Bun.spawnSync(argv, { cwd });
  if (res.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${res.stderr.toString()}`);
  return res.stdout.toString().trim();
};

export const tempRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "brewery-test-"));
  run(dir, "git", "init", "-q", "-b", "master");
  run(dir, "git", "config", "user.email", "test@example.com");
  run(dir, "git", "config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "# test repo\n");
  run(dir, "git", "add", "-A");
  run(dir, "git", "commit", "-q", "-m", "Initial commit");
  return dir;
};

// Point every agent at the fake, and brewery's config/index at the temp dir.
export const fakeSetup = (dir: string, plan: unknown[], stages: Record<string, string[]> = {}): { planPath: string; config: Config } => {
  const planPath = join(dir, "..", `${dir.split("/").pop()}-plan.json`);
  writeFileSync(planPath, JSON.stringify(plan));
  const profile = (name: string): Config["agents"][string] => ({
    type: "command",
    command: ["bun", FAKE],
    env: { FAKE_PLAN: planPath, FAKE_AGENT_NAME: name },
  });
  const configPath = join(dir, "..", `${dir.split("/").pop()}-config.json`);
  writeFileSync(
    configPath,
    JSON.stringify({
      agents: { alpha: profile("alpha"), beta: profile("beta") },
      stages: {
        distill: ["alpha"],
        cut: ["alpha", "beta"],
        pick: ["alpha"],
        roast: ["beta"],
        review: ["alpha", "beta"],
        brew: ["alpha"],
        taste: ["alpha"],
        compound: ["alpha"],
        cellar: ["alpha"],
        approve: ["alpha"],
        ...stages,
      },
      // Never ping the real webhook from tests.
      notify: { ntfyUrl: "" },
    }),
  );
  process.env.BREWERY_CONFIG = configPath;
  process.env.BREWERY_INDEX = join(dir, "..", `${dir.split("/").pop()}-index.json`);
  return { planPath, config: loadConfig(dir) };
};

export const quietCtx = (state: RunState, config: Config): Ctx & { lines: string[] } => {
  const lines: string[] = [];
  return { state, config, log: (line: string) => lines.push(line), lines };
};

export const fakeCi = (snapshots: PrSnapshot[], pr = 7, log = ""): Ci & { waits: number } => {
  let i = 0;
  const ci = {
    waits: 0,
    prForBranch: async (): Promise<number> => pr,
    prView: async (): Promise<never> => { throw new Error("fakeCi.prView not scripted"); },
    prFiles: async (): Promise<never> => { throw new Error("fakeCi.prFiles not scripted"); },
    prDiff: async (): Promise<never> => { throw new Error("fakeCi.prDiff not scripted"); },
    prUrl: async (_cwd: string, number: number): Promise<string> => `https://example.test/pr/${number}`,
    snapshot: async (): Promise<PrSnapshot> => snapshots[Math.min(i++, snapshots.length - 1)],
    waitForChecks: async (): Promise<void> => {
      ci.waits += 1;
    },
    failedLog: async (): Promise<string> => log,
  };
  return ci;
};

export const IP = (status: string): string => `# Add greeting

The repo has no greeting. This adds one so a new visitor sees hello.

## The idea

A text file.

## Tasks

- [ ] **T1** — Add greeting file
- [ ] **T2** — Add farewell file

## Open questions (recommendation assumed)

None.

## Sign-off

Status: ${status}
`;
