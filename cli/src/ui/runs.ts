// Run discovery for `brewery ui`. Every route resolves a run through `findRun` and reads
// files, `.brewery.json`, and the PHI flag only through the fields it returns, never
// through `state.repo`, so later sources (zerg scan roots, peers) change no route.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readIndex, runDir as stateRunDir, type Phase, type RunState } from "../state.ts";

export interface RunRef {
  state: RunState;
  source: string;
  runDir: string;
  repoRoot: string;
  phi: boolean;
  writable: boolean;
}

export interface RunSummary {
  id: string;
  source: string;
  slug: string;
  repo: string;
  phase: Phase;
  waiting: boolean;
  live: boolean;
  pr?: number;
  updatedAt: string;
}

export interface SourceStatus {
  id: string;
  kind: "local" | "scan" | "peer";
  status: "ok" | "unreadable" | "unreachable";
  detail?: string;
}

export interface RunsContext {
  // The repository `brewery ui` was started in (`--repo`, default cwd).
  repo: string;
}

const LOCAL = "local";
const HEARTBEAT_FRESH_MS = 15_000;

export const runId = (source: string, slug: string): string => `${source}~${slug}`;

// A repo is PHI only when its own `.brewery.json` says so (D7: opt in, default false).
export const readPhi = (repoRoot: string): boolean => {
  try {
    const json = JSON.parse(readFileSync(join(repoRoot, ".brewery.json"), "utf8")) as { phi?: unknown };
    return json.phi === true;
  } catch {
    return false;
  }
};

const readState = (dir: string): RunState | undefined => {
  try {
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as RunState;
    return state && typeof state.slug === "string" ? state : undefined;
  } catch {
    return undefined;
  }
};

const pidAlive = (dir: string): boolean => {
  try {
    const pid = Number(readFileSync(join(dir, "run.pid"), "utf8").trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const isLive = (ref: RunRef): boolean => {
  if (pidAlive(ref.runDir)) return true;
  const heartbeat = (ref.state.waiting as { heartbeat?: string } | undefined)?.heartbeat;
  const at = heartbeat ? Date.parse(heartbeat) : NaN;
  return Number.isFinite(at) && Date.now() - at < HEARTBEAT_FRESH_MS;
};

const localRef = (repoRoot: string, slug: string): RunRef | undefined => {
  const dir = stateRunDir(repoRoot, slug);
  const state = readState(dir);
  if (!state) return undefined;
  // A local run's repo is the one its state names; the directory it was found under is
  // where its files live (the two agree for every run brewery itself writes).
  const root = typeof state.repo === "string" && state.repo ? state.repo : repoRoot;
  return { state, source: LOCAL, runDir: dir, repoRoot: root, phi: readPhi(root), writable: true };
};

// Slugs with a run directory under the start repo.
const repoSlugs = (repo: string): string[] => {
  const base = join(repo, ".terreno", "brewery");
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, "state.json")))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

const safeIndex = (): Record<string, string> => {
  try {
    return readIndex();
  } catch {
    return {};
  }
};

// The start repo's runs win over an index entry for the same slug.
const localRefs = (ctx: RunsContext): RunRef[] => {
  const refs = new Map<string, RunRef>();
  for (const slug of repoSlugs(ctx.repo)) {
    const ref = localRef(ctx.repo, slug);
    if (ref) refs.set(slug, ref);
  }
  for (const [slug, repo] of Object.entries(safeIndex())) {
    if (refs.has(slug) || typeof repo !== "string") continue;
    const ref = localRef(repo, slug);
    if (ref) refs.set(slug, ref);
  }
  return [...refs.values()];
};

const updatedAt = (ref: RunRef): string => {
  try {
    return statSync(join(ref.runDir, "state.json")).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
};

export const listRuns = (ctx: RunsContext): { runs: RunSummary[]; sources: SourceStatus[] } => {
  const runs = localRefs(ctx).map((ref): RunSummary => ({
    id: runId(ref.source, ref.state.slug),
    source: ref.source,
    slug: ref.state.slug,
    repo: ref.repoRoot,
    phase: ref.state.phase,
    waiting: Boolean(ref.state.waiting),
    live: isLive(ref),
    ...(ref.state.pr ? { pr: ref.state.pr } : {}),
    updatedAt: updatedAt(ref),
  }));
  runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { runs, sources: [{ id: LOCAL, kind: "local", status: "ok" }] };
};

export const findRun = (id: string, ctx: RunsContext): RunRef | undefined => {
  const sep = id.indexOf("~");
  if (sep < 0) return undefined;
  const source = id.slice(0, sep);
  const slug = id.slice(sep + 1);
  if (source !== LOCAL || !slug || slug.includes("/") || slug.includes("\\") || slug === "." || slug === "..") return undefined;
  const own = localRef(ctx.repo, slug);
  if (own) return own;
  const repo = safeIndex()[slug];
  return typeof repo === "string" ? localRef(repo, slug) : undefined;
};

// `local~<slug>` → the slug, or undefined for another source or an unsafe slug.
const localSlug = (id: string): string | undefined => {
  const sep = id.indexOf("~");
  if (sep < 0) return undefined;
  const source = id.slice(0, sep);
  const slug = id.slice(sep + 1);
  if (source !== LOCAL || !slug || slug.includes("/") || slug.includes("\\") || slug === "." || slug === "..") return undefined;
  return slug;
};

// Where a slug's run may live: the start repo first, then the index.
const candidateRoots = (slug: string, ctx: RunsContext): string[] => {
  const indexed = safeIndex()[slug];
  return [ctx.repo, ...(typeof indexed === "string" ? [indexed] : [])];
};

// True when `findRun` found nothing but the run's state.json is on disk: the run exists
// and its state is unreadable (corrupt, or mid-write by a foreign tool).
export const runUnreadable = (id: string, ctx: RunsContext): boolean => {
  const slug = localSlug(id);
  if (!slug || findRun(id, ctx)) return false;
  return candidateRoots(slug, ctx).some((root) => existsSync(join(stateRunDir(root, slug), "state.json")));
};
