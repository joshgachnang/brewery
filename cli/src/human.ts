// The only path to the human. Agents never talk to them; they put decisions in `ask`,
// and brewery sends one message, pings the phone (with no content), and waits.
import type { Ask } from "./agents.ts";
import { appendEvent } from "./events.ts";
import { saveState, type RunState } from "./state.ts";

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
  link: string;
  asks: Ask[];
  replyHint: string;
}

export const buildMessage = (m: MessageParts): string => {
  const lines = [`[${m.repoName}] ${m.title}: ${m.need}`, ""];
  if (m.orientation) lines.push(m.orientation, "");
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

// Read one reply from the terminal when a person is at it; null otherwise.
export const readReplyFromTty = (enabled: boolean): string | null => {
  if (!enabled || !process.stdin.isTTY) return null;
  const reply = prompt("reply (blank to answer later)>");
  return reply?.trim() ? reply.trim() : null;
};
