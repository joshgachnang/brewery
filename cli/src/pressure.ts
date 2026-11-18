// A sandbox that is out of threads or memory fails brewery's own children ("git status:
// Resource temporarily unavailable") at the moment three agents peak together. That is a
// reason to run fewer tasks at once, not a reason to end the run.
import { readFileSync } from "node:fs";
import { totalmem } from "node:os";

const TRANSIENT = /resource temporarily unavailable|cannot allocate memory|EAGAIN|ENOMEM|fork: retry|unable to create (?:thread|new native thread)|pthread_create/i;

export const isResourceError = (error: unknown): boolean => {
  const text = error instanceof Error ? `${(error as NodeJS.ErrnoException).code ?? ""} ${error.message}` : String(error);
  return TRANSIENT.test(text);
};

let level = 0;

export const pressureLevel = (): number => level;
export const resetPressure = (): void => {
  level = 0;
};
// Each report takes one more task away from the parallel limit, never below one.
export const reportPressure = (): number => ++level;

export const retryDelaysMs = [1_000, 3_000, 9_000];

export interface Capacity {
  memoryBytes: number;
  pidsFree: number | null;
}

const readNumber = (file: string): number | null => {
  try {
    const text = readFileSync(file, "utf8").trim();
    return /^\d+$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
};

// The container's own limits: cgroup files when they exist, else what the kernel reports as
// memory (a gVisor sandbox reports its limit there). Pids are unknown, not unlimited, when no
// cgroup file names them.
export const readCapacity = (): Capacity => {
  const limit = readNumber("/sys/fs/cgroup/memory.max") ?? readNumber("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  const memoryBytes = limit && limit < totalmem() ? limit : totalmem();
  const max = readNumber("/sys/fs/cgroup/pids.max");
  const current = readNumber("/sys/fs/cgroup/pids.current");
  return { memoryBytes, pidsFree: max !== null && current !== null ? Math.max(max - current, 0) : null };
};

export interface Budget {
  taskMemoryMb: number;
  taskPids: number;
}

// How many tasks the sandbox can carry at once: the configured limit, cut to what memory and
// free pids allow at a budget per task, then by every resource failure seen this run. Never zero.
export const effectiveParallel = (configured: number, budget: Budget, capacity: Capacity = readCapacity(), pressure: number = level): number => {
  const byMemory = Math.floor(capacity.memoryBytes / (budget.taskMemoryMb * 1024 * 1024));
  const byPids = capacity.pidsFree === null ? configured : Math.floor(capacity.pidsFree / budget.taskPids);
  return Math.max(1, Math.min(configured, byMemory, byPids) - pressure);
};
