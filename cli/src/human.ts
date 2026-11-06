// The only path to the human. Agents never talk to them; they put decisions in `ask`,
// and brewery sends one message, pings the phone (with no content), and waits.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { Ask } from "./agents.ts";
import { appendEvent } from "./events.ts";
import { runDir, saveState, type RunState } from "./state.ts";

export type Verdict = "approve" | "reject" | "answer";

export const parseReply = (reply: string): Verdict => {
  const text = reply.trim().toLowerCase();
  if (/^(no|reject|rejected|nope)\b/.test(text)) return "reject";
  if (/^(ok|okay|approve|approved|lgtm|yes|ship it|go)\b/.test(text)) return "approve";
  return "answer";
};

export const formatAsks = (asks: Ask[]): string =>
  asks
    .map((a, i) => {
      const letters = "abcdefgh";
      const opts = a.opts?.length
        ? ` ${a.opts.map((o, j) => `${letters[j]}) ${o}${o === a.rec ? " (recommended)" : ""}`).join(" ")}`
        : ` Recommended: ${a.rec}`;
      return `${i + 1}. ${a.q}${opts}`;
    })
    .join("\n");

export interface MessageParts {
  repoName: string;
  title: string;
  need: string;
  orientation?: string;
  // Omitted when the IP has no Elephant line; "none" only when the planner wrote it.
  elephant?: string;
  link: string;
  asks: Ask[];
  replyHint: string;
}

export const buildMessage = (m: MessageParts): string => {
  const lines = [`[${m.repoName}] ${m.title}: ${m.need}`, ""];
  if (m.orientation) lines.push(m.orientation, "");
  if (m.elephant) lines.push(`Elephant: ${m.elephant}`, "");
  lines.push(`Plan: ${m.link}`, "");
  if (m.asks.length) lines.push("Needs an answer:", formatAsks(m.asks.slice(0, 5)), "");
  lines.push(m.replyHint);
  return lines.join("\n");
};

export const smsVersion = (m: MessageParts, slug: string): string => {
  const text = `[${m.repoName}] ${m.title}: ${m.need}. ${m.asks.length} question(s). Reply with: brewery answer ${slug} "ok"`;
  return text.length > 480 ? `${text.slice(0, 477)}...` : text;
};

// ntfy bodies never carry the question: messages leave the HIPAA boundary.
export const ping = async (ntfyUrl: string | undefined, text: string): Promise<void> => {
  if (!ntfyUrl) return;
  try {
    await fetch(ntfyUrl, { method: "POST", body: text, headers: { Title: "brewery" } });
  } catch {
    // A failed ping must not fail the run; the message is still printed and saved.
  }
};

export const waitForHuman = async (
  state: RunState,
  kind: "signoff" | "gate",
  asks: Ask[],
  message: string,
  ntfyUrl: string | undefined,
  log: (line: string) => void,
): Promise<void> => {
  state.waiting = { kind, asks, message, since: new Date().toISOString() };
  saveState(state);
  appendEvent(state, { kind: "waiting", waitingKind: kind, message, ...(state.ip ? { ip: state.ip } : {}) });
  await ping(ntfyUrl, `brewery: ${state.slug} needs you (${kind === "signoff" ? "sign-off" : "decision"})`);
  log(`\n──── message for the human ────\n${message}\n───────────────────────────────`);
  log(`Waiting. Answer with: brewery answer ${state.slug} "<reply>"`);
};

export interface WaitOptions {
  state: RunState;
  // A terminal to read a line from, or null when nobody is at one.
  tty?: NodeJS.ReadableStream | null;
  // Without a TTY, how long to watch reply.json before giving up. 0 gives up at once.
  replyWaitMin: number;
  // How often reply.json is checked; the heartbeat is rewritten every 2.5 polls (2 s → 5 s).
  pollMs?: number;
}

type FileReply = { reply: string } | "unreadable" | undefined;

// reply.json is `{reply, at}`, written by `brewery ui` or by hand into the run directory.
const readReplyFile = (path: string): FileReply => {
  if (!existsSync(path)) return undefined;
  try {
    const body = JSON.parse(readFileSync(path, "utf8")) as { reply?: unknown };
    return typeof body?.reply === "string" && body.reply.trim() ? { reply: body.reply.trim() } : "unreadable";
  } catch {
    return "unreadable";
  }
};

// Wait for the human's reply from reply.json or, when one is attached, a terminal line.
// Whichever arrives first wins. Resolves null when the wait ends with no reply.
export const waitForReply = async ({ state, tty, replyWaitMin, pollMs = 2000 }: WaitOptions): Promise<string | null> => {
  const path = join(runDir(state.repo, state.slug), "reply.json");
  const beat = (): void => {
    if (!state.waiting) return;
    state.waiting.heartbeat = new Date().toISOString();
    saveState(state);
  };
  const deadline = tty ? Number.POSITIVE_INFINITY : Date.now() + replyWaitMin * 60_000;
  let unreadable: string | undefined;
  const takeFile = (): string | null => {
    const found = readReplyFile(path);
    if (found === undefined) return null;
    if (found === "unreadable") {
      let body = "";
      try {
        body = readFileSync(path, "utf8");
      } catch {
        return null;
      }
      // One note per distinct bad body, not one per poll.
      if (body !== unreadable) {
        unreadable = body;
        appendEvent(state, { kind: "note", text: "reply.json unreadable: want {\"reply\": \"...\"}; left in place" });
      }
      return null;
    }
    rmSync(path, { force: true });
    return found.reply;
  };

  const first = takeFile();
  if (first !== null) return first;
  if (!tty && Date.now() >= deadline) return null;

  return new Promise<string | null>((resolve) => {
    let done = false;
    let rl: Interface | undefined;
    const timers: Array<ReturnType<typeof setInterval>> = [];
    const finish = (reply: string | null): void => {
      if (done) return;
      done = true;
      for (const timer of timers) clearInterval(timer);
      rl?.close();
      if (state.waiting?.heartbeat) {
        delete state.waiting.heartbeat;
        saveState(state);
      }
      resolve(reply);
    };
    beat();
    timers.push(setInterval(beat, Math.max(1, Math.round(pollMs * 2.5))));
    timers.push(setInterval(() => {
      const reply = takeFile();
      if (reply !== null) finish(reply);
      else if (Date.now() >= deadline) finish(null);
    }, pollMs));
    if (tty) {
      rl = createInterface({ input: tty, terminal: false });
      if (tty === process.stdin) process.stdout.write("reply (blank to answer later)> ");
      rl.once("line", (line) => finish(line.trim() ? line.trim() : null));
      rl.once("close", () => finish(null));
    }
  });
};
