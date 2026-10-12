// CI failure evidence. finish writes one file per failing check per head sha before Taste
// reacts, and marks them fixed (or flaky) once the PR is green. `brewery cellar` turns the
// failure → fix pairs into learnings.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scrubTail } from "./scrub.ts";
import { runDir, slugify, type RunState } from "./state.ts";
import type { Check, Ci } from "./vcs.ts";

export interface CiFailure {
  check: string;
  link?: string;
  pr?: number;
  sha: string;
  at: string;
  log: string;
  // fixed: green at a later sha (fixSha); flaky: green again at the same sha
  status: "open" | "fixed" | "flaky";
  fixSha?: string;
  resolvedAt?: string;
}

export const ciDir = (state: RunState): string => join(runDir(state.repo, state.slug), "ci");

export const readFailures = (state: RunState): { file: string; failure: CiFailure }[] => {
  const dir = ciDir(state);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ file: join(dir, f), failure: JSON.parse(readFileSync(join(dir, f), "utf8")) as CiFailure }));
};

const save = (file: string, failure: CiFailure): void => writeFileSync(file, `${JSON.stringify(failure, null, 2)}\n`);

// One file per check per sha; a repeat snapshot of the same failure writes nothing.
export const recordFailures = async (state: RunState, ci: Ci, sha: string, failing: Check[]): Promise<string[]> => {
  const existing = readFailures(state);
  const dir = ciDir(state);
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  let n = existing.length;
  for (const check of failing) {
    if (existing.some(({ failure }) => failure.check === check.name && failure.sha === sha)) continue;
    const log = check.link ? scrubTail(await ci.failedLog(state.repo, check.link)) : "";
    n += 1;
    const file = join(dir, `${String(n).padStart(3, "0")}-${slugify(check.name) || "check"}.json`);
    save(file, { check: check.name, link: check.link, pr: state.pr, sha, at: new Date().toISOString(), log, status: "open" });
    written.push(file);
  }
  return written;
};

export const resolveFailures = (state: RunState, greenSha: string): void => {
  for (const { file, failure } of readFailures(state)) {
    if (failure.status !== "open") continue;
    const flaky = failure.sha === greenSha;
    save(file, {
      ...failure,
      status: flaky ? "flaky" : "fixed",
      ...(flaky ? {} : { fixSha: greenSha }),
      resolvedAt: new Date().toISOString(),
    });
  }
};
