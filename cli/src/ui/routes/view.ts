// A run's view model (pipeline, tasks, active agents, waiting, totals) over HTTP, and the
// watcher the events stream uses to push a fresh view whenever state.json changes.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, type Stage } from "../../config.ts";
import type { BreweryEvent } from "../../events.ts";
import type { RunState } from "../../state.ts";
import type { RunRef } from "../runs.ts";
import { buildRunView, type RunView } from "../view.ts";

export const STATE_UNREADABLE = "state.json is unreadable";

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const TASK_STATUSES: ReadonlySet<string> = new Set(["todo", "running", "passed", "skipped"]);
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Throws on a missing or corrupt file, or one whose shape the view cannot be built from,
// so the caller decides between 500 and "skip". Task fields reach the page as structure even
// in a PHI run, so a value brewery would not write (a foreign or older version's state) is
// coerced rather than passed through or allowed to fail the whole view.
const readState = (run: RunRef): RunState => {
  const state = JSON.parse(readFileSync(join(run.runDir, "state.json"), "utf8")) as unknown;
  if (!isObject(state) || typeof state.slug !== "string" || typeof state.phase !== "string") throw new Error("not a run state");
  if (!isObject(state.tasks) || !Array.isArray(state.history)) throw new Error("not a run state");
  const tasks = Object.fromEntries(
    Object.entries(state.tasks).map(([id, task]) => {
      const t = isObject(task) ? task : {};
      const status = TASK_STATUSES.has(t.status as string) ? t.status : "todo";
      const attempts = typeof t.attempts === "number" && Number.isFinite(t.attempts) ? t.attempts : 0;
      return [id, { ...t, status, attempts }];
    }),
  );
  return { ...state, tasks } as unknown as RunState;
};

// Unparsable lines (a half-written tail, a foreign line) are skipped, never fatal.
const readEvents = (run: RunRef): (BreweryEvent & { t?: string })[] => {
  let text: string;
  try {
    text = readFileSync(join(run.runDir, "events.jsonl"), "utf8");
  } catch {
    return [];
  }
  const events: (BreweryEvent & { t?: string })[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as BreweryEvent & { t?: string };
      if (event && typeof event === "object" && typeof event.kind === "string") events.push(event);
    } catch {
      // Skip it.
    }
  }
  return events;
};

// A repo whose config names an unknown agent still gets a view; its routes fall back to
// brewery's defaults rather than failing the page.
const configuredRoutes = (run: RunRef): Record<Stage, string[]> => {
  try {
    return loadConfig(run.repoRoot).stages;
  } catch {
    return DEFAULT_CONFIG.stages;
  }
};

const viewOf = (run: RunRef, state: RunState): RunView =>
  buildRunView({ state, events: readEvents(run), configuredRoutes: configuredRoutes(run), phi: run.phi, now: new Date() });

export const viewRoute = (_req: Request, run: RunRef, _params: Record<string, string>): Response => {
  try {
    return json(viewOf(run, readState(run)));
  } catch {
    // A fixed message: a parse error quotes the file, and state.json holds free text.
    return json({ error: STATE_UNREADABLE }, 500);
  }
};

const mtimeOf = (path: string): number | undefined => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
};

// Call once per second: returns a fresh view whenever state.json's mtime moved since the
// stream opened or the last pushed view, otherwise undefined. A corrupt or half-written
// file is skipped and retried on the next call, so the stream stays open and the next
// valid write recovers it. Nothing is pushed on open: a client that must not miss a change
// opens the stream first, then GETs the view.
export const stateWatcher = (run: RunRef): (() => RunView | undefined) => {
  const path = join(run.runDir, "state.json");
  let last = mtimeOf(path);
  return () => {
    const mtime = mtimeOf(path);
    if (mtime === undefined || mtime === last) return undefined;
    try {
      const view = viewOf(run, readState(run));
      last = mtime;
      return view;
    } catch {
      return undefined;
    }
  };
};
