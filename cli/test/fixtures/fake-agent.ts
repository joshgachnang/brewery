#!/usr/bin/env bun
// A scripted stand-in for claude/codex. Reads the prompt on stdin, finds the first plan
// entry whose `match` appears in the "## Step:" line and still has uses left, applies
// its file writes, and writes its result to $BREWERY_RESULT_FILE.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

interface Entry {
  match: string;
  agent?: string;
  times?: number;
  write?: Record<string, string>;
  result?: Record<string, unknown>;
  noResult?: boolean;
  sleepMs?: number;
  signal?: string;
  waitFor?: string[];
  waitForTask?: { id: string; status: string };
  sleepAfterResultMs?: number;
}

const prompt = await new Response(Bun.stdin.stream()).text();
const step = /^## Step: (.+)$/m.exec(prompt)?.[1] ?? "";
const agent = process.env.FAKE_AGENT_NAME ?? "fake";
const planPath = process.env.FAKE_PLAN as string;
const usedPath = `${planPath}.used.json`;
const plan = JSON.parse(readFileSync(planPath, "utf8")) as Entry[];
// Reserve scripted uses under a file lock: parallel agent processes share the plan.
const lockPath = `${planPath}.lock`;
let lock: number;
for (;;) {
  try { lock = openSync(lockPath, "wx"); break; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await Bun.sleep(5);
  }
}
const used: Record<string, number> = existsSync(usedPath) ? JSON.parse(readFileSync(usedPath, "utf8")) : {};

const index = plan.findIndex(
  (e, i) => step.includes(e.match) && (!e.agent || e.agent === agent) && (used[i] ?? 0) < (e.times ?? Number.POSITIVE_INFINITY),
);
appendFileSync(`${planPath}.calls.log`, `${agent}\t${step}\t${process.cwd()}\t${existsSync(join(process.cwd(), ".terreno"))}\n`);
if (index < 0) {
  closeSync(lock);
  unlinkSync(lockPath);
  console.error(`fake-agent: no plan entry for step "${step}" (${agent})`);
  process.exit(2);
}
used[index] = (used[index] ?? 0) + 1;
writeFileSync(usedPath, JSON.stringify(used));
closeSync(lock);
unlinkSync(lockPath);
const entry = plan[index];
appendFileSync(`${planPath}.timings.log`, `${step}\tstart\t${Date.now()}\n`);
if (entry.signal) writeFileSync(`${planPath}.${entry.signal}`, "started");
const deadline = Date.now() + 15_000;
for (;;) {
  const signalsReady = (entry.waitFor ?? []).every((signal) => existsSync(`${planPath}.${signal}`));
  let taskReady = !entry.waitForTask;
  if (entry.waitForTask) {
    try {
      const state = JSON.parse(readFileSync(join(dirname(dirname(process.env.BREWERY_RESULT_FILE as string)), "state.json"), "utf8"));
      taskReady = state.tasks[entry.waitForTask.id]?.status === entry.waitForTask.status;
    } catch { /* A concurrent state write is retried. */ }
  }
  if (signalsReady && taskReady) break;
  if (Date.now() >= deadline) throw new Error(`fake-agent: timed out at rendezvous for ${step}`);
  await Bun.sleep(10);
}
if (entry.sleepMs) await Bun.sleep(entry.sleepMs);
for (const [path, content] of Object.entries(entry.write ?? {})) {
  mkdirSync(dirname(join(process.cwd(), path)), { recursive: true });
  writeFileSync(join(process.cwd(), path), content);
}
if (!entry.noResult) {
  writeFileSync(process.env.BREWERY_RESULT_FILE as string, JSON.stringify(entry.result ?? { status: "PASS", action: "done" }));
}

appendFileSync(`${planPath}.timings.log`, `${step}\tend\t${Date.now()}\n`);
if (entry.sleepAfterResultMs) await Bun.sleep(entry.sleepAfterResultMs);
