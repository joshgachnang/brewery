import { describe, expect, test } from "bun:test";
import { ciConfigured, isGreen } from "../src/commands/finish.ts";
import { effectiveParallel, isResourceError, readCapacity, resetPressure, reportPressure } from "../src/pressure.ts";
import { findDescendants, findOrphans, reapOrphans, RUN_ENV, type ProcInfo, type ProcSource } from "../src/reap.ts";
import { isCrash, supervise, type Exit } from "../src/supervise.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUN = "/repo/.terreno/brewery/x";

const fake = (procs: ProcInfo[]): ProcSource & { killed: [number, string][] } => {
  const dead = new Set<number>();
  const killed: [number, string][] = [];
  return {
    killed,
    list: () => procs.filter((p) => !dead.has(p.pid)),
    kill: (pid, signal) => {
      killed.push([pid, signal]);
      dead.add(pid);
    },
    alive: (pid) => !dead.has(pid),
    sleep: async () => {},
  };
};

describe("orphan agents", () => {
  const procs: ProcInfo[] = [
    { pid: 10, ppid: 1, runDir: RUN }, // agent left by a dead brewery
    { pid: 11, ppid: 10, runDir: RUN }, // its test server
    { pid: 20, ppid: 1, runDir: "/repo/.terreno/brewery/other" }, // another run's
    { pid: 30, ppid: 1 }, // unrelated
    { pid: 100, ppid: 1 }, // this brewery
    { pid: 101, ppid: 100, runDir: RUN }, // its own live agent
    { pid: 102, ppid: 101, runDir: RUN },
  ];

  test("finds marked processes that are not this brewery's own", () => {
    expect(findOrphans(RUN, fake(procs), 100).sort()).toEqual([10, 11]);
  });

  test("finds this brewery's own marked descendants for shutdown", () => {
    expect(findDescendants(RUN, fake(procs), 100).sort()).toEqual([101, 102]);
  });

  test("stops them with TERM, and KILL only for what survives", async () => {
    const source = fake(procs);
    // pid 11 ignores TERM: the fake records the signal but leaves it alive.
    const stubborn: ProcSource = { ...source, kill: (pid, signal) => (pid === 11 && signal === "SIGTERM" ? void source.killed.push([pid, signal]) : source.kill(pid, signal)) };
    await reapOrphans(RUN, { source: stubborn, self: 100, graceMs: 1 });
    expect(source.killed).toEqual([[10, "SIGTERM"], [11, "SIGTERM"], [11, "SIGKILL"]]);
  });

  test("lists nothing when processes cannot be read", () => {
    expect(findOrphans(RUN, { ...fake([]), list: () => null })).toEqual([]);
  });

  test("the marker name is stable, because running agents carry it", () => {
    expect(RUN_ENV).toBe("BREWERY_RUN_DIR");
  });
});

describe("resource pressure", () => {
  test("recognizes thread and memory exhaustion", () => {
    expect(isResourceError(new Error("git status failed: Resource temporarily unavailable"))).toBe(true);
    expect(isResourceError(Object.assign(new Error("spawn failed"), { code: "EAGAIN" }))).toBe(true);
    expect(isResourceError("fatal: cannot allocate memory")).toBe(true);
    expect(isResourceError(new Error("merge conflict"))).toBe(false);
  });

  test("parallel limit shrinks to memory, free pids and reported failures, never below one", () => {
    const budget = { taskMemoryMb: 3072, taskPids: 300 };
    const gb = 1024 ** 3;
    expect(effectiveParallel(3, budget, { memoryBytes: 16 * gb, pidsFree: null }, 0)).toBe(3);
    expect(effectiveParallel(3, budget, { memoryBytes: 8 * gb, pidsFree: null }, 0)).toBe(2);
    expect(effectiveParallel(3, budget, { memoryBytes: 16 * gb, pidsFree: 650 }, 0)).toBe(2);
    expect(effectiveParallel(3, budget, { memoryBytes: 16 * gb, pidsFree: null }, 1)).toBe(2);
    expect(effectiveParallel(3, budget, { memoryBytes: 1 * gb, pidsFree: 0 }, 5)).toBe(1);
  });

  test("each reported failure lowers the live limit", () => {
    resetPressure();
    const capacity = { memoryBytes: 64 * 1024 ** 3, pidsFree: null };
    const budget = { taskMemoryMb: 3072, taskPids: 300 };
    expect(effectiveParallel(3, budget, capacity)).toBe(3);
    reportPressure();
    expect(effectiveParallel(3, budget, capacity)).toBe(2);
    resetPressure();
  });

  test("capacity reads without throwing", () => {
    expect(readCapacity().memoryBytes).toBeGreaterThan(0);
  });
});

describe("supervisor", () => {
  const run = (exits: Exit[]) => {
    const calls: number[] = [];
    const lines: string[] = [];
    return {
      calls,
      lines,
      go: (maxRestarts: number) =>
        supervise({ maxRestarts, log: (l) => lines.push(l), sleep: async () => {}, sweep: async () => null, run: async () => exits[calls.push(1) - 1] ?? { code: 0, signal: null } }),
    };
  };

  test("classifies panics and OOM kills as crashes, and ordinary exits as not", () => {
    expect(isCrash({ code: 134, signal: null })).toBe(true);
    expect(isCrash({ code: null, signal: "SIGKILL" })).toBe(true);
    expect(isCrash({ code: 0, signal: null })).toBe(false);
    expect(isCrash({ code: 3, signal: null })).toBe(false); // waiting on the human
    expect(isCrash({ code: 1, signal: null })).toBe(false); // an error brewery reported
    expect(isCrash({ code: null, signal: "SIGTERM" })).toBe(false);
  });

  test("restarts after a crash until the command exits normally", async () => {
    const r = run([{ code: 134, signal: null }, { code: null, signal: "SIGKILL" }, { code: 0, signal: null }]);
    expect(await r.go(5)).toBe(0);
    expect(r.calls.length).toBe(3);
  });

  test("stops on a gate for the human and on an ordinary error", async () => {
    expect(await run([{ code: 3, signal: null }]).go(5)).toBe(3);
    const r = run([{ code: 1, signal: null }]);
    expect(await r.go(5)).toBe(1);
    expect(r.calls.length).toBe(1);
  });

  test("gives up after the restart cap", async () => {
    const r = run(Array.from({ length: 10 }, () => ({ code: 134, signal: null })));
    expect(await r.go(2)).toBe(134);
    expect(r.calls.length).toBe(3);
    expect(r.lines.at(-1)).toContain("giving up");
  });
});

describe("a PR with no checks", () => {
  const snap = { sha: "a", mergeable: "MERGEABLE" as const, mergeState: "CLEAN", checks: [] };

  test("is not green when the repo defines CI", () => {
    expect(isGreen(snap)).toBe(false);
    expect(isGreen(snap, true)).toBe(false);
  });

  test("is green when the repo has no CI at all", () => {
    expect(isGreen(snap, false)).toBe(true);
  });

  test("a repo has CI when a workflow directory has files", () => {
    const repo = mkdtempSync(join(tmpdir(), "brewery-ci-"));
    expect(ciConfigured(repo)).toBe(false);
    mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
    expect(ciConfigured(repo)).toBe(false);
    writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "name: ci\n");
    expect(ciConfigured(repo)).toBe(true);
  });
});
