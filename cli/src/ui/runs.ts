// Run discovery for `brewery ui`. Every route resolves a run through `findRun` and reads
// files, `.brewery.json`, and the PHI flag only through the fields it returns, never
// through `state.repo`, so later sources (zerg scan roots, peers) change no route.
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { readIndex, runDir as stateRunDir, type Phase, type RunState } from "../state.ts";

export interface RunRef {
  state: RunState;
  source: string;
  runDir: string;
  repoRoot: string;
  phi: boolean;
  writable: boolean;
  // A scanned run's workspace directory name (the session name on the zerg host).
  workspace?: string;
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
  workspace?: string;
}

export interface SourceStatus {
  id: string;
  kind: "local" | "scan" | "peer";
  status: "ok" | "unreadable" | "unreachable" | "read-only";
  detail?: string;
}

export interface RunsContext {
  // The repository `brewery ui` was started in (`--repo`, default cwd).
  repo: string;
  // `--scan` globs (or `ui.scan`): each matching directory is a workspace with its own runs.
  scan?: string[];
}

const LOCAL = "local";
const SCAN = "scan";
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

// A scanned run's run.pid is a pid in its container's namespace, meaningless on this host, so
// only its waiting heartbeat counts.
const isLive = (ref: RunRef): boolean => {
  if (ref.source === LOCAL && pidAlive(ref.runDir)) return true;
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

export const refId = (ref: RunRef): string =>
  ref.workspace !== undefined ? `${SCAN}~${ref.workspace}~${ref.state.slug}` : runId(ref.source, ref.state.slug);

// A workspace or slug name that is safe in a path and unambiguous in a run ID.
const safeName = (name: string): boolean => Boolean(name) && !/[/\\~]/.test(name) && name !== "." && name !== "..";

// ---- Scan sources: zerg session workspaces (`/srv/agent-workspaces/*/merged`). ----

interface Workspace {
  dir: string;
  // The last directory name a wildcard matched (the session name), else the dir's own name.
  workspace: string;
}

const GLOB_CHARS = /[*?[{]/;

const errCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;
const missing = (error: unknown): boolean => errCode(error) === "ENOENT" || errCode(error) === "ENOTDIR";

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

// Expands one segment at a time, so a directory the server cannot list is reported rather
// than silently dropped. Wildcards match within one path segment (no `**`).
const expandGlob = (pattern: string): { matches: Workspace[]; unreadable: string[] } => {
  const absolute = isAbsolute(pattern) ? pattern : resolve(pattern);
  const segments = absolute.split("/").filter(Boolean);
  let frontier: { dir: string; workspace?: string }[] = [{ dir: "/" }];
  const unreadable: string[] = [];
  for (const segment of segments) {
    const next: { dir: string; workspace?: string }[] = [];
    for (const { dir, workspace } of frontier) {
      if (!GLOB_CHARS.test(segment)) {
        next.push({ dir: join(dir, segment), workspace });
        continue;
      }
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch (error) {
        if (!missing(error)) unreadable.push(dir);
        continue;
      }
      const glob = new Bun.Glob(segment);
      for (const name of names.sort()) {
        if (glob.match(name) && isDir(join(dir, name))) next.push({ dir: join(dir, name), workspace: name });
      }
    }
    frontier = next;
  }
  return { matches: frontier.map(({ dir, workspace }) => ({ dir, workspace: workspace ?? basename(dir) })), unreadable };
};

// A scanned state.json holds container paths (`repo: "/workspace"`, step logs under it).
// Each one is moved onto the host workspace; one that cannot be is dropped, never opened.
const within = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

// A scanned state.json holds container paths (`repo: "/workspace"`, step logs under it).
// Each one is moved onto the host workspace; one that cannot be, or that `..` would carry
// out of the workspace, is dropped, never opened.
const rebase = (path: string, state: RunState, repoRoot: string, runDir: string): string => {
  const from = typeof state.repo === "string" ? state.repo.replace(/\/+$/, "") : "";
  if (from && within(path, from)) {
    const host = join(repoRoot, path.slice(from.length));
    return within(host, repoRoot) ? host : "";
  }
  const marker = `/.terreno/brewery/${state.slug}/`;
  const at = path.indexOf(marker);
  if (at < 0) return "";
  const host = join(runDir, path.slice(at + marker.length));
  return within(host, runDir) ? host : "";
};

const canWrite = (path: string): boolean => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const realOf = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

// A container owns everything under its workspace, so a symlink there could serve another
// workspace's files (under this workspace's PHI flag) or a host file. The run directory must
// resolve inside the workspace, and the files the routes open must not be links.
const contained = (wsDir: string, runDir: string): boolean => {
  const realWs = realOf(wsDir);
  const realRun = realOf(runDir);
  if (!realWs || !realRun || !within(realRun, realWs)) return false;
  return !["state.json", "events.jsonl"].some((name) => isLink(join(runDir, name)));
};

const scanRef = (ws: Workspace, slug: string): RunRef | undefined => {
  const dir = stateRunDir(ws.dir, slug);
  if (!contained(ws.dir, dir)) return undefined;
  const raw = readState(dir);
  if (!raw || raw.slug !== slug) return undefined;
  const history = Array.isArray(raw.history)
    ? raw.history.map((entry) => (entry && typeof entry.log === "string" ? { ...entry, log: rebase(entry.log, raw, ws.dir, dir) } : entry))
    : raw.history;
  const state: RunState = { ...raw, repo: ws.dir, history };
  return { state, source: SCAN, runDir: dir, repoRoot: ws.dir, phi: readPhi(ws.dir), writable: canWrite(dir), workspace: ws.workspace };
};

// state.json is missing (skip), or present but not readable by this user (report).
const stateUnreadable = (runDir: string): "missing" | "unreadable" | "ok" => {
  try {
    accessSync(join(runDir, "state.json"), constants.R_OK);
    return "ok";
  } catch (error) {
    return missing(error) ? "missing" : "unreadable";
  }
};

const scanGlob = (glob: string): { refs: RunRef[]; source: SourceStatus } => {
  const { matches, unreadable } = expandGlob(glob);
  const refs: RunRef[] = [];
  const clashes: string[] = [];
  const named = new Map<string, string>();
  for (const ws of matches) {
    if (!safeName(ws.workspace)) continue;
    // Two directories under one name would share run IDs; the first keeps the name.
    const real = realOf(ws.dir) ?? ws.dir;
    const prior = named.get(ws.workspace);
    if (prior !== undefined && prior !== real) {
      clashes.push(ws.dir);
      continue;
    }
    named.set(ws.workspace, real);
    if (prior !== undefined) continue;
    const base = join(ws.dir, ".terreno", "brewery");
    let slugs: string[];
    try {
      slugs = readdirSync(base).sort();
    } catch (error) {
      if (!missing(error)) unreadable.push(ws.dir);
      continue;
    }
    for (const slug of slugs) {
      if (!safeName(slug)) continue;
      const access = stateUnreadable(join(base, slug));
      if (access === "unreadable") unreadable.push(join(base, slug));
      if (access !== "ok") continue;
      const ref = scanRef(ws, slug);
      if (ref) refs.push(ref);
    }
  }
  const readOnly = refs.filter((ref) => !ref.writable).map((ref) => ref.runDir);
  const id = `${SCAN}:${glob}`;
  const detail = [
    unreadable.length ? `cannot read ${unreadable.join(", ")}` : "",
    readOnly.length ? `cannot write ${readOnly.join(", ")}` : "",
    clashes.length ? `workspace name already taken, skipped ${clashes.join(", ")}` : "",
  ].filter(Boolean).join("; ");
  const status: SourceStatus["status"] = unreadable.length ? "unreadable" : readOnly.length ? "read-only" : "ok";
  return { refs, source: { id, kind: "scan", status, ...(detail ? { detail } : {}) } };
};

// The first glob that matches a workspace name owns it, as in the list.
const scanWorkspace = (workspace: string, ctx: RunsContext): Workspace | undefined => {
  for (const glob of ctx.scan ?? []) {
    const match = expandGlob(glob).matches.find((m) => m.workspace === workspace);
    if (match) return match;
  }
  return undefined;
};

const scanParts = (rest: string): { workspace: string; slug: string } | undefined => {
  const last = rest.lastIndexOf("~");
  const workspace = rest.slice(0, last);
  const slug = rest.slice(last + 1);
  return last < 0 || !safeName(workspace) || !safeName(slug) ? undefined : { workspace, slug };
};

const summary = (ref: RunRef): RunSummary => ({
  id: refId(ref),
  source: ref.source,
  slug: ref.state.slug,
  repo: ref.repoRoot,
  phase: ref.state.phase,
  waiting: Boolean(ref.state.waiting),
  live: isLive(ref),
  ...(ref.state.pr ? { pr: ref.state.pr } : {}),
  updatedAt: updatedAt(ref),
  ...(ref.workspace !== undefined ? { workspace: ref.workspace } : {}),
});

export const listRuns = (ctx: RunsContext): { runs: RunSummary[]; sources: SourceStatus[] } => {
  const refs = localRefs(ctx);
  const sources: SourceStatus[] = [{ id: LOCAL, kind: "local", status: "ok" }];
  for (const glob of ctx.scan ?? []) {
    const scanned = scanGlob(glob);
    refs.push(...scanned.refs);
    sources.push(scanned.source);
  }
  // Two globs can reach the same workspace name; the first owns its IDs, as in findRun.
  const seen = new Set<string>();
  const runs = refs.filter((ref) => !seen.has(refId(ref)) && Boolean(seen.add(refId(ref)))).map(summary);
  runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { runs, sources };
};

export const findRun = (id: string, ctx: RunsContext): RunRef | undefined => {
  const sep = id.indexOf("~");
  if (sep < 0) return undefined;
  const source = id.slice(0, sep);
  const rest = id.slice(sep + 1);
  if (source === SCAN) {
    const parts = scanParts(rest);
    const ws = parts ? scanWorkspace(parts.workspace, ctx) : undefined;
    return ws && parts ? scanRef(ws, parts.slug) : undefined;
  }
  const slug = rest;
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
  if (id.startsWith(`${SCAN}~`)) {
    const parts = scanParts(id.slice(SCAN.length + 1));
    const ws = parts ? scanWorkspace(parts.workspace, ctx) : undefined;
    if (!ws || !parts || findRun(id, ctx)) return false;
    const dir = stateRunDir(ws.dir, parts.slug);
    return contained(ws.dir, dir) && existsSync(join(dir, "state.json"));
  }
  const slug = localSlug(id);
  if (!slug || findRun(id, ctx)) return false;
  return candidateRoots(slug, ctx).some((root) => existsSync(join(stateRunDir(root, slug), "state.json")));
};
