// Test databases a killed or crashed step leaves in the temp directory. An in-memory
// MongoDB writes about 300 MB per instance and only removes it on a clean exit, so a few
// dozen dead steps fill the volume the repo and the task worktrees share. Once it is full
// the agent's runtime aborts and the step "exits without writing its result file".
import { readdirSync, statfsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Directory name prefixes that test database servers create under the temp directory.
export const LEFTOVER_PREFIXES = ["mongo-mem-"];

// A server makes its directory before its process starts (and may download a binary in
// between), so a young directory with no process is not yet a leftover.
const GRACE_MS = 5 * 60_000;

// mongod refuses to start below 500 MB free, and a runtime that cannot write aborts.
export const LOW_DISK_BYTES = 512 * 1024 * 1024;

export interface SweepOptions {
  roots?: string[];
  // Command lines of every live process; null when they cannot be listed.
  commands?: string[] | null;
  now?: number;
  graceMs?: number;
}

export interface SweepReport {
  removed: string[];
  bytes: number;
}

export const liveCommands = (): string[] | null => {
  try {
    const res = Bun.spawnSync(["ps", "axww", "-o", "args="], { stdout: "pipe", stderr: "ignore", timeout: 15_000 });
    if (res.exitCode !== 0) return null;
    const lines = res.stdout.toString().split("\n").filter(Boolean);
    return lines.length ? lines : null;
  } catch {
    return null;
  }
};

const treeBytes = (dir: string): number => {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        total += statSync(join(entry.parentPath, entry.name)).size;
      } catch {
        // A file that vanished mid-walk counts for nothing.
      }
    }
  } catch {
    // Unreadable: still try to remove it, just report no size.
  }
  return total;
};

const defaultRoots = (): string[] => [...new Set([tmpdir(), "/tmp"])];

// Remove test database directories that no live process names on its command line. When
// the process list is unavailable nothing is removed: a live database is never guessed at.
export const sweepLeftovers = async (opts: SweepOptions = {}): Promise<SweepReport> => {
  const report: SweepReport = { removed: [], bytes: 0 };
  const commands = opts.commands === undefined ? liveCommands() : opts.commands;
  if (!commands) return report;
  const now = opts.now ?? Date.now();
  const graceMs = opts.graceMs ?? GRACE_MS;
  const uid = process.getuid?.();
  for (const root of opts.roots ?? defaultRoots()) {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!LEFTOVER_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
      const dir = join(root, name);
      try {
        const stat = statSync(dir);
        if (!stat.isDirectory()) continue;
        if (uid !== undefined && stat.uid !== uid) continue;
        if (now - stat.mtimeMs < graceMs) continue;
        if (commands.some((command) => command.includes(dir))) continue;
        const bytes = treeBytes(dir);
        await rm(dir, { recursive: true, force: true });
        report.removed.push(dir);
        report.bytes += bytes;
      } catch {
        // Another sweep got there first, or it is not ours to remove.
      }
    }
  }
  return report;
};

const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export const sweepLine = (report: SweepReport): string | null =>
  report.removed.length
    ? `  removed ${report.removed.length} leftover test database${report.removed.length === 1 ? "" : "s"} (${gb(report.bytes)}) from ${[...new Set(report.removed.map((dir) => join(dir, "..")))].join(", ")}`
    : null;

const freeBytes = (path: string): number | null => {
  try {
    const stat = statfsSync(path);
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
};

// Names the first of `paths` whose volume is nearly full, so a step that died for lack of
// disk says so instead of looking like an agent or runtime bug.
export const lowDiskNote = (paths: string[], free: (path: string) => number | null = freeBytes): string | null => {
  for (const path of paths) {
    const bytes = free(path);
    if (bytes !== null && bytes < LOW_DISK_BYTES) return `the disk is nearly full (${Math.round(bytes / 1024 ** 2)} MB free at ${path}); free space before rerunning`;
  }
  return null;
};
