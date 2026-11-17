import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveCommands, LOW_DISK_BYTES, lowDiskNote, sweepLeftovers, sweepLine } from "../src/scratch.ts";
import { newState } from "../src/state.ts";
import { runStage } from "../src/step.ts";
import { fakeSetup, tempRepo } from "./helpers.ts";

const HOUR = 60 * 60_000;

// A database directory as a dead server leaves it, last touched `ageMs` ago.
const database = (root: string, name: string, ageMs: number): string => {
  const dir = join(root, name);
  mkdirSync(join(dir, "journal"), { recursive: true });
  writeFileSync(join(dir, "collection.wt"), "x".repeat(1000));
  writeFileSync(join(dir, "journal", "log.1"), "x".repeat(500));
  const when = new Date(Date.now() - ageMs);
  utimesSync(dir, when, when);
  return dir;
};

const root = (): string => mkdtempSync(join(tmpdir(), "brewery-scratch-"));

describe("leftover test databases", () => {
  test("a database no process uses is removed and its size reported", async () => {
    const dir = root();
    const dead = database(dir, "mongo-mem-dead01", HOUR);
    const report = await sweepLeftovers({ roots: [dir], commands: ["bun test"] });
    expect(existsSync(dead)).toBe(false);
    expect(report).toEqual({ removed: [dead], bytes: 1500 });
    expect(sweepLine(report)).toContain("removed 1 leftover test database (");
  });

  test("a database a live process names is kept", async () => {
    const dir = root();
    const live = database(dir, "mongo-mem-live01", HOUR);
    const dead = database(dir, "mongo-mem-dead01", HOUR);
    const report = await sweepLeftovers({ roots: [dir], commands: [`mongod-x64-debian-7.0.24 --port 4711 --dbpath ${live} --replSet rs0`] });
    expect(existsSync(live)).toBe(true);
    expect(report.removed).toEqual([dead]);
  });

  test("a database whose server may still be starting is kept", async () => {
    const dir = root();
    const young = database(dir, "mongo-mem-young1", 30_000);
    expect((await sweepLeftovers({ roots: [dir], commands: [] })).removed).toEqual([]);
    expect(existsSync(young)).toBe(true);
  });

  test("nothing is removed when the process list is unavailable", async () => {
    const dir = root();
    const dead = database(dir, "mongo-mem-dead01", HOUR);
    expect((await sweepLeftovers({ roots: [dir], commands: null })).removed).toEqual([]);
    expect(existsSync(dead)).toBe(true);
  });

  test("other temp directories and plain files are left alone", async () => {
    const dir = root();
    const other = database(dir, "brewery-test-abc", HOUR);
    writeFileSync(join(dir, "mongo-mem-notes.txt"), "keep");
    const report = await sweepLeftovers({ roots: [dir, join(dir, "missing")], commands: [] });
    expect(report.removed).toEqual([]);
    expect(sweepLine(report)).toBeNull();
    expect(existsSync(other)).toBe(true);
    expect(existsSync(join(dir, "mongo-mem-notes.txt"))).toBe(true);
  });

  test("the real process list sees a running server's data directory", async () => {
    const dir = root();
    const live = database(dir, "mongo-mem-live01", HOUR);
    const proc = Bun.spawn(["bun", "-e", "setTimeout(() => {}, 60000)", "--dbpath", live], { stdout: "ignore", stderr: "ignore" });
    try {
      expect(liveCommands()?.some((command) => command.includes(live))).toBe(true);
      expect((await sweepLeftovers({ roots: [dir] })).removed).toEqual([]);
      expect(existsSync(live)).toBe(true);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test("a step reclaims what an earlier killed step left in the temp directory", async () => {
    const dead = database(tmpdir(), `mongo-mem-${crypto.randomUUID()}`, HOUR);
    const repo = tempRepo();
    const { config } = fakeSetup(repo, [{ stage: "pick", status: "PASS", action: "built" }]);
    const state = newState({ slug: "leftovers", repo, ip: "", base: "master", phase: "build" });
    const lines: string[] = [];
    await runStage({ state, config, log: (line) => lines.push(line) }, "pick", "Build it.");
    expect(existsSync(dead)).toBe(false);
    expect(lines.some((line) => line.includes("leftover test database"))).toBe(true);
  });
});

describe("a step that dies on a full disk", () => {
  test("names the full volume", () => {
    const note = lowDiskNote(["/roomy", "/full"], (path) => (path === "/full" ? 3 * 1024 * 1024 : LOW_DISK_BYTES * 4));
    expect(note).toContain("3 MB free at /full");
  });

  test("says nothing when there is room or the volume cannot be read", () => {
    expect(lowDiskNote(["/roomy", "/gone"], (path) => (path === "/gone" ? null : LOW_DISK_BYTES))).toBeNull();
  });
});
