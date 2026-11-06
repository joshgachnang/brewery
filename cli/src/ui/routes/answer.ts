// POST /api/runs/:id/answer {reply} and /note {text}: what `brewery answer` and
// `brewery note` do, from the page, without racing a live process.
//   - A live waiter (heartbeat < 15 s) gets the reply through reply.json.
//   - A local run with no waiter and no lock holder gets a detached `brewery answer`.
//     A scanned run's process lives in its container; this host never starts one for it.
//   - Anything else is 409 with the command to run in the run's own session.
// The server has already checked the token and the Origin.
import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appendEvent } from "../../events.ts";
import { appendNote, runDir, type RunState } from "../../state.ts";
import { inRunDir, type RunRef } from "../runs.ts";

const WAITER_FRESH_MS = 15_000;
// A child spawned this recently may not have taken run.lock yet; a second answer waits for it.
const SPAWN_GRACE_MS = 10_000;
const spawned = new Map<string, { pid: number; at: number }>();

// A compiled `brewery` is its own CLI; from source, cli.ts sits beside this module.
const COMPILED = import.meta.dir.startsWith("/$bunfs");
const CLI_SOURCE = join(import.meta.dir, "../../cli.ts");

const json = (body: unknown, status: number): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

// Quoted for a POSIX shell so the command can be pasted as is: plain text in double quotes,
// anything that a shell would expand (including bash's `!`) in single quotes.
const shellQuote = (text: string): string =>
  /^[^"\\$`!']*$/.test(text) ? `"${text}"` : `'${text.replace(/'/g, "'\\''")}'`;
const shellWord = (text: string): string => (/^[A-Za-z0-9._-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`);

const pidAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

// A process owns the run: run.lock exists and run.pid names a live process, or a child
// this server started has not taken the lock yet.
const lockHeld = (run: RunRef): boolean => {
  const recent = spawned.get(run.runDir);
  if (recent && pidAlive(recent.pid) && Date.now() - recent.at < SPAWN_GRACE_MS) return true;
  if (!existsSync(join(run.runDir, "run.lock"))) return false;
  try {
    return pidAlive(Number(readFileSync(join(run.runDir, "run.pid"), "utf8").trim()));
  } catch {
    return false;
  }
};

const liveWaiter = (state: RunState): boolean => {
  const at = state.waiting?.heartbeat ? Date.parse(state.waiting.heartbeat) : NaN;
  return Number.isFinite(at) && Date.now() - at < WAITER_FRESH_MS;
};

// The shared writers (`appendNote`, and the child's run lock) resolve the run directory
// from the repo; act only when that is the directory this run was found in.
const sameDir = (run: RunRef): boolean => resolve(runDir(run.repoRoot, run.state.slug)) === resolve(run.runDir);
const writableState = (run: RunRef): RunState => ({ ...run.state, repo: run.repoRoot });

const readBody = async (req: Request, field: string): Promise<{ value: string } | Response> => {
  const type = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return json({ error: "send JSON (Content-Type: application/json)" }, 415);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "body is not JSON" }, 400);
  }
  const value = body && typeof body === "object" ? (body as Record<string, unknown>)[field] : undefined;
  if (typeof value !== "string" || !value.trim()) return json({ error: `${field} is required` }, 400);
  return { value };
};

// A new file only: O_EXCL refuses any existing name, a planted link included, so a write
// never follows a link out of the run directory.
const NEW_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

const writeReply = (run: RunRef, reply: string): boolean => {
  const path = join(run.runDir, "reply.json");
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  if (!inRunDir(run, tmp) || !inRunDir(run, path)) return false;
  const fd = openSync(tmp, NEW_FILE, 0o644);
  try {
    writeFileSync(fd, `${JSON.stringify({ reply, at: new Date().toISOString() })}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  return true;
};

const spawnAnswer = (run: RunRef, reply: string): { pid: number; log: string } | undefined => {
  const log = join(run.runDir, `ui-answer-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  const fd = openSync(log, NEW_FILE, 0o644);
  const argv = COMPILED ? [] : [CLI_SOURCE];
  try {
    const child = spawn(process.execPath, [...argv, "answer", run.state.slug, reply, "--repo", run.repoRoot], {
      cwd: run.repoRoot,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: process.env,
    });
    // A failed spawn has no pid; its error event must not crash the server.
    child.on("error", () => {});
    child.unref();
    const pid = child.pid;
    if (!pid) return undefined;
    spawned.set(run.runDir, { pid, at: Date.now() });
    return { pid, log };
  } finally {
    closeSync(fd);
  }
};

const answer = async (req: Request, run: RunRef): Promise<Response> => {
  const body = await readBody(req, "reply");
  if (body instanceof Response) return body;
  const reply = body.value;
  if (!run.state.waiting) return json({ error: "run is not waiting for a reply" }, 409);
  const command = `brewery answer ${shellWord(run.state.slug)} ${shellQuote(reply)}`;
  if (!run.writable || !sameDir(run)) return json({ error: "this run can only be answered in its own session", command }, 409);
  if (liveWaiter(run.state)) {
    if (!writeReply(run, reply)) return json({ error: "this run can only be answered in its own session", command }, 409);
    return json({ via: "reply-file" }, 202);
  }
  if (run.source !== "local") return json({ error: "no live waiter; answer in the run's own session", command }, 409);
  if (lockHeld(run)) return json({ error: "another brewery process owns this run", command }, 409);
  const child = spawnAnswer(run, reply);
  if (!child) return json({ error: "could not start brewery answer", command }, 500);
  return json({ via: "spawn", ...child }, 202);
};

const note = async (req: Request, run: RunRef): Promise<Response> => {
  const body = await readBody(req, "text");
  if (body instanceof Response) return body;
  const text = body.value;
  if (!run.writable || !sameDir(run)) {
    const command = `brewery note ${shellWord(run.state.slug)} ${shellQuote(text)}`;
    return json({ error: "this run takes notes only in its own session", command }, 409);
  }
  const state = writableState(run);
  appendNote(state, text);
  appendEvent(state, { kind: "note", text });
  return json({ ok: true }, 200);
};

export const answerRoute = (req: Request, run: RunRef, params: Record<string, string>): Promise<Response> =>
  params.action === "note" ? note(req, run) : answer(req, run);
