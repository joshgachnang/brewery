// Append-only progress feed for one brewery run. Readers can resume at a byte offset.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { runDir, type RunState } from "./state.ts";

export type BreweryEvent =
  | { kind: "step.start"; seq: number; stage: string; task?: string; agent: string }
  | { kind: "step.end"; seq: number; status: string; action: string; seconds: number }
  | { kind: "narration"; seq: number; text: string }
  | { kind: "waiting"; waitingKind: "signoff" | "gate"; message: string; ip?: string }
  | { kind: "resumed" }
  | { kind: "note"; text: string }
  | { kind: "pr"; number: number; url: string }
  | { kind: "ci"; state: "pass" | "fail" | "pending" }
  | { kind: "done" }
  | { kind: "error"; message: string };

export const appendEvent = (state: RunState, event: BreweryEvent): void => {
  const path = join(runDir(state.repo, state.slug), "events.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`);
};
