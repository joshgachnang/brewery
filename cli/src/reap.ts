// Finding and stopping agent processes a dead brewery left behind. A brewery that panics, is
// OOM-killed or loses its container takes only itself down: its agents and their test servers
// are reparented to init and keep running, holding threads, memory and database directories
// that the next run then trips over. Every child brewery starts carries BREWERY_RUN_DIR, which
// its own children inherit, so the survivors are found by that marker. Pids are never stored:
// under gVisor every container hands out the same low pids, so a remembered pid can name
// another session's process.
import { readdirSync, readFileSync } from "node:fs";

export const RUN_ENV = "BREWERY_RUN_DIR";

export interface ProcInfo {
  pid: number;
  ppid: number;
  runDir?: string;
}

export interface ProcSource {
  list: () => ProcInfo[] | null;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  alive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
}

const readProc = (pid: number): ProcInfo | null => {
  try {
    // comm may contain spaces and parentheses: the fields that matter follow the last ")".
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (!Number.isInteger(ppid)) return null;
    let runDir: string | undefined;
    try {
      const environ = readFileSync(`/proc/${pid}/environ`, "utf8");
      for (const entry of environ.split("\0")) if (entry.startsWith(`${RUN_ENV}=`)) runDir = entry.slice(RUN_ENV.length + 1);
    } catch {
      // Not ours to read, or gone: it cannot carry our marker.
    }
    return { pid, ppid, ...(runDir ? { runDir } : {}) };
  } catch {
    return null;
  }
};

// Linux only. Elsewhere (a laptop) there are no orphans of this kind to find, so nothing is listed.
export const systemProcs: ProcSource = {
  list: () => {
    try {
      return readdirSync("/proc")
        .filter((name) => /^\d+$/.test(name))
        .map((name) => readProc(Number(name)))
        .filter((info): info is ProcInfo => info !== null);
    } catch {
      return null;
    }
  },
  kill: (pid, signal) => {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  },
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const descendantsOf = (root: number, procs: ProcInfo[]): Set<number> => {
  const found = new Set<number>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const proc of procs) {
      if (!found.has(proc.pid) && (proc.ppid === root || found.has(proc.ppid))) {
        found.add(proc.pid);
        grew = true;
      }
    }
  }
  return found;
};

// Processes that carry this run's marker and are not this process or its own descendants.
export const findOrphans = (runDir: string, source: ProcSource = systemProcs, self: number = process.pid): number[] => {
  const procs = source.list();
  if (!procs) return [];
  const mine = descendantsOf(self, procs);
  return procs.filter((proc) => proc.runDir === runDir && proc.pid !== self && !mine.has(proc.pid)).map((proc) => proc.pid);
};

// Marked processes that are this process's own descendants: what a shutdown must not leave running.
export const findDescendants = (runDir: string, source: ProcSource = systemProcs, self: number = process.pid): number[] => {
  const procs = source.list();
  if (!procs) return [];
  const mine = descendantsOf(self, procs);
  return procs.filter((proc) => proc.runDir === runDir && mine.has(proc.pid)).map((proc) => proc.pid);
};

export interface ReapOptions {
  source?: ProcSource;
  graceMs?: number;
  self?: number;
}

const stopAll = async (pids: number[], source: ProcSource, graceMs: number): Promise<number[]> => {
  if (!pids.length) return [];
  for (const pid of pids) source.kill(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && pids.some((pid) => source.alive(pid))) await source.sleep(Math.min(250, graceMs));
  for (const pid of pids) if (source.alive(pid)) source.kill(pid, "SIGKILL");
  return pids;
};

export const reapOrphans = async (runDir: string, opts: ReapOptions = {}): Promise<number[]> => {
  const source = opts.source ?? systemProcs;
  return stopAll(findOrphans(runDir, source, opts.self), source, opts.graceMs ?? 5_000);
};

export const reapDescendants = async (runDir: string, opts: ReapOptions = {}): Promise<number[]> => {
  const source = opts.source ?? systemProcs;
  return stopAll(findDescendants(runDir, source, opts.self), source, opts.graceMs ?? 2_000);
};

export const reapLine = (pids: number[]): string | null =>
  pids.length ? `  stopped ${pids.length} agent process${pids.length === 1 ? "" : "es"} left running by an earlier brewery` : null;
