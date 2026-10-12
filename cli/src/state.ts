// Per-run state lives in the target repo under .terreno/brewery/<slug>/ (git-ignored).
// A small global index maps slugs to repos so `brewery answer <slug>` works anywhere.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Ask, Finding, Status } from "./agents.ts";

export type Phase = "distill" | "signoff" | "approved" | "build" | "integrate" | "review" | "brew" | "finish" | "done";

export interface TaskState {
  status: "todo" | "running" | "passed" | "skipped";
  worktree?: string;
  branch?: string;
  attempts: number;
  commit?: string;
  evidence?: string;
}

export interface HistoryEntry {
  seq: number;
  stage: string;
  agent: string;
  status: Status;
  action: string;
  seconds: number;
  log: string;
  task?: string;
}

export interface Answer {
  q: string;
  a: string;
  at: string;
}

export interface RunState {
  v: 1;
  slug: string;
  repo: string;
  ip: string;
  base: string;
  branch?: string;
  phase: Phase;
  request?: string;
  seq: number;
  tasks: Record<string, TaskState>;
  pr?: number;
  waiting?: { kind: "signoff" | "gate"; asks: Ask[]; message: string; since: string; task?: string };
  answers: Answer[];
  notes?: string[];
  cutRounds: number;
  reviewRounds: number;
  parallelRan?: boolean;
  integrationRounds?: number;
  landing?: { task: string; head: string; ip: string; index?: { mode: string; sha: string; path: string } };
  reviewPending?: boolean;
  reviewFindings?: Finding[];
  finish?: { startedAt: string; pushes: number; reactions: number; stuck: number; lastKey?: string };
  history: HistoryEntry[];
}

export const runDir = (repo: string, slug: string): string => join(repo, ".terreno", "brewery", slug);
const statePath = (repo: string, slug: string): string => join(runDir(repo, slug), "state.json");
const stateLockPath = (repo: string, slug: string): string => join(runDir(repo, slug), "state.lock");
export const contextPath = (repo: string, slug: string): string => join(runDir(repo, slug), "context.md");

// A command owns the run until it exits. state.lock remains a separate short-lived
// mutex so `note` can write while an agent step is running.
export const withRunLock = async <T>(state: RunState, work: () => Promise<T>): Promise<T> => {
  const dir = runDir(state.repo, state.slug);
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "run.lock");
  const pidFile = join(dir, "run.pid");
  // Never reclaim this short-lived guard automatically: doing so would move the
  // same stale-owner race to another pathname. A crash here fails closed.
  const guard = join(dir, "run.guard");
  const ownerFile = join(lock, "owner");
  const owner = crypto.randomUUID();
  const guarded = (action: () => void): void => {
    try { mkdirSync(guard); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new Error(`brewery: ${state.slug} is already running (run.guard held; if abandoned, remove it only after stopping all run commands)`);
    }
    try { action(); }
    finally { rmdirSync(guard); }
  };
  guarded(() => {
    if (existsSync(lock)) {
      const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
      let alive = false;
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); alive = true; }
        catch (signalError) { alive = (signalError as NodeJS.ErrnoException).code === "EPERM"; }
      }
      if (alive || (!pid && Date.now() - statSync(lock).mtimeMs < 2000)) {
        throw new Error(`brewery: ${state.slug} is already running${pid ? ` (pid ${pid})` : ""}`);
      }
      rmSync(lock, { recursive: true, force: true });
      rmSync(pidFile, { force: true });
    }
    mkdirSync(lock);
    writeFileSync(ownerFile, owner);
    writeFileSync(pidFile, `${process.pid}\n`);
  });
  try {
    return await work();
  } finally {
    // Acquisition and release share the guard, so the token check and removal
    // cannot race a replacement owner.
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        guarded(() => {
          if (!existsSync(ownerFile) || readFileSync(ownerFile, "utf8") !== owner) return;
          rmSync(pidFile, { force: true });
          rmSync(lock, { recursive: true, force: true });
        });
        break;
      } catch (error) {
        if (!existsSync(guard) || Date.now() >= deadline) throw error;
        await Bun.sleep(10);
      }
    }
  }
};

const indexPath = (): string =>
  process.env.BREWERY_INDEX ?? join(homedir(), ".local", "state", "brewery", "runs.json");

export const readIndex = (): Record<string, string> => {
  const path = indexPath();
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>) : {};
};

export const refreshNotes = (state: RunState): void => {
  const path = statePath(state.repo, state.slug);
  if (!existsSync(path)) return;
  const stored = JSON.parse(readFileSync(path, "utf8")) as RunState;
  if ((stored.notes?.length ?? 0) > (state.notes?.length ?? 0)) state.notes = stored.notes;
};

const withStateLock = <T>(state: RunState, work: () => T): T => {
  const dir = runDir(state.repo, state.slug);
  mkdirSync(dir, { recursive: true });
  const lock = stateLockPath(state.repo, state.slug);
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() > deadline) throw new Error(`brewery: timed out waiting for state lock in ${dir}`);
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30000) rmdirSync(lock);
        else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      } catch (race) {
        if ((race as NodeJS.ErrnoException).code !== "ENOENT") throw race;
      }
    }
  }
  try {
    return work();
  } finally {
    rmdirSync(lock);
  }
};

const writeState = (state: RunState): void => {
  const dir = runDir(state.repo, state.slug);
  mkdirSync(join(dir, "steps"), { recursive: true });
  const temporary = join(dir, `state.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, statePath(state.repo, state.slug));
  const index = readIndex();
  if (index[state.slug] !== state.repo) {
    index[state.slug] = state.repo;
    mkdirSync(dirname(indexPath()), { recursive: true });
    writeFileSync(indexPath(), `${JSON.stringify(index, null, 2)}\n`);
  }
};

export const saveState = (state: RunState): void => withStateLock(state, () => {
  refreshNotes(state);
  writeState(state);
});

export const loadState = (slug: string, repo?: string): RunState => {
  const root = repo ?? readIndex()[slug];
  if (!root || !existsSync(statePath(root, slug))) {
    throw new Error(`brewery: no run "${slug}"${repo ? ` in ${repo}` : ""}. See \`brewery status\`.`);
  }
  return JSON.parse(readFileSync(statePath(root, slug), "utf8")) as RunState;
};

export const newState = (fields: { slug: string; repo: string; ip: string; base: string; phase: Phase }): RunState => ({
  v: 1,
  ...fields,
  seq: 0,
  tasks: {},
  answers: [],
  notes: [],
  cutRounds: 0,
  reviewRounds: 0,
  history: [],
});

// The user-context packet: only what the human said, verbatim. Cut sees nothing else.
export const appendContext = (state: RunState, heading: string, body: string): void => {
  const path = contextPath(state.repo, state.slug);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `## ${heading}\n\n${body.trim()}\n\n`);
};

export const appendNote = (state: RunState, text: string): void => {
  withStateLock(state, () => {
    const latest = loadState(state.slug, state.repo);
    const path = contextPath(state.repo, state.slug);
    appendFileSync(path, `## Human note\n\n${text}\n\n`);
    (latest.notes ??= []).push(text);
    writeState(latest);
    state.notes = latest.notes;
  });
};

export const readContext = (state: RunState): string => {
  const path = contextPath(state.repo, state.slug);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "");
