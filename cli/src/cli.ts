#!/usr/bin/env bun
// brewery — run distill → cut → sign-off → barrel → finish as separate agent processes.
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { availability } from "./agents.ts";
import { appendEvent } from "./events.ts";
import { answer } from "./commands/answer.ts";
import { barrel } from "./commands/barrel.ts";
import { findingsTable, runCut } from "./commands/cut.ts";
import { defaultIpPath, distill } from "./commands/distill.ts";
import { finish } from "./commands/finish.ts";
import { FAN_OUT, loadConfig, STAGES, userConfigPath } from "./config.ts";
import { readReplyFromTty } from "./human.ts";
import { isApproved, parseTasks, readIp, readStatus } from "./ip.ts";
import { appendContext, appendNote, loadState, newState, readIndex, saveState, slugify, withRunLock, type RunState } from "./state.ts";
import type { Ctx } from "./step.ts";
import { defaultBase, ensureExcluded, githubCi, repoRoot } from "./vcs.ts";

const HELP = `brewery — plan and ship a feature with separate agents per step.

Usage:
  brewery distill "<request>" [--file req.md] [--slug s] [--ip path] [--go]
      Write the IP, attack it with cut, fix it, and send it for sign-off.
  brewery answer <slug> "<reply>" [--go]
      Apply a sign-off reply ("ok", "ok, 2b", "no: <why>") or a gate answer
      ("1a", "retry: <hint>", "skip", "ship", "stop"), then continue a waiting run.
  brewery note <slug> "<text>"
      Record a mid-run human note for later steps and cut.
  brewery resume <slug> [--go]
      Continue a stopped run from its saved phase (refuses a concurrent run).
  brewery barrel <slug> | --ip <path>
      Approved IP → pick/roast every task → branch review → brew → finish.
  brewery finish [pr] [--slug s]
      Taste until the PR has no conflicts and all checks pass.
  brewery cut <ip> [--request "text" | --context file]
      Attack an IP with only the human's words; prints findings.
  brewery status [slug]        Runs, phases, and what is waiting on you
  brewery agents               Agent profiles, availability, and stage routing
  brewery help

Common flags:
  --agents stage=a+b,...   Override routing, e.g. pick=claude,roast=claude+codex+local
  --repo <dir>             Target repository (default: current directory)
  --no-wait                Never read a reply from the terminal
  --go                     After approval, keep going into barrel
  --parallel N             Max concurrent task builds for this run (1 = sequential)

Config: ${userConfigPath()} and <repo>/.brewery.json.
Exit codes: 0 done or approved, 3 waiting on the human, 1 error.`;

const WAITING = 3;

const parseArgs = (argv: string[]): { positional: string[]; flags: Record<string, string | true> } => {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2);
    const next = argv[i + 1];
    if (inline !== undefined) flags[name] = inline;
    else if (["go", "no-wait", "here"].includes(name) || next === undefined || next.startsWith("--")) flags[name] = true;
    else flags[name] = argv[++i];
  }
  return { positional, flags };
};

const str = (value: string | true | undefined): string | undefined => (typeof value === "string" ? value : undefined);

const log = (line: string): void => console.log(line);

let activeState: RunState | undefined;
const makeCtx = (state: RunState, agentsFlag?: string, parallel?: string | true): Ctx => {
  activeState = state;
  const config = loadConfig(state.repo, agentsFlag);
  if (parallel !== undefined) {
    const limit = typeof parallel === "string" && /^\d+$/.test(parallel) ? Number(parallel) : NaN;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("brewery: --parallel needs a positive integer");
    config.limits.parallelTasks = limit;
  }
  return { state, config, log };
};

const afterApproval = async (ctx: Ctx, go: boolean): Promise<number> => {
  if (!go) return 0;
  return (await barrel(ctx, githubCi)) === "done" ? 0 : WAITING;
};

// When someone is at the terminal, take the reply right here instead of exiting.
const replyLoop = async (ctx: Ctx, interactive: boolean, go: boolean): Promise<number> => {
  while (ctx.state.waiting) {
    const reply = readReplyFromTty(interactive);
    if (!reply) return WAITING;
    const outcome = await answer(ctx, reply);
    if (outcome === "approved") return afterApproval(ctx, go);
    if (outcome === "stopped") return 0;
    if (outcome === "continue") {
      const result = await barrel(ctx, githubCi);
      if (result === "done") return 0;
    }
  }
  return 0;
};

const cmdDistill = async (positional: string[], flags: Record<string, string | true>): Promise<number> => {
  const file = str(flags.file);
  const request = file ? readFileSync(file, "utf8") : positional.join(" ");
  if (!request.trim()) throw new Error('brewery distill needs a request: brewery distill "<request>"');
  const repo = await repoRoot(str(flags.repo) ?? process.cwd());
  await ensureExcluded(repo);
  const slug = str(flags.slug) ?? slugify(request);
  const ipFlag = str(flags.ip);
  const ip = ipFlag ? (isAbsolute(ipFlag) ? ipFlag : join(repo, ipFlag)) : defaultIpPath(repo, slug);
  const state = newState({ slug, repo, ip, base: await defaultBase(repo), phase: "distill" });
  return withRunLock(state, async () => {
    const ctx = makeCtx(state, str(flags.agents), flags.parallel);
    log(`brewery distill ${slug} in ${repo}`);
    await distill(ctx, request);
    return replyLoop(ctx, !flags["no-wait"], Boolean(flags.go));
  });
};

const cmdAnswer = async (positional: string[], flags: Record<string, string | true>): Promise<number> => {
  const [slug, ...rest] = positional;
  const reply = rest.join(" ");
  if (!slug || !reply) throw new Error('usage: brewery answer <slug> "<reply>"');
  const state = loadState(slug, str(flags.repo));
  return withRunLock(state, async () => {
    const ctx = makeCtx(state, str(flags.agents), flags.parallel);
    const outcome = await answer(ctx, reply);
    if (outcome === "approved") return afterApproval(ctx, Boolean(flags.go));
    if (outcome === "stopped") return 0;
    if (outcome === "waiting") return replyLoop(ctx, !flags["no-wait"], Boolean(flags.go));
    const result = await barrel(ctx, githubCi);
    return result === "done" ? 0 : replyLoop(ctx, !flags["no-wait"], true);
  });
};

const cmdNote = (positional: string[], flags: Record<string, string | true>): number => {
  const [slug, ...rest] = positional;
  const note = rest.join(" ");
  if (!slug || !note.trim()) throw new Error('usage: brewery note <slug> "<text>"');
  const state = loadState(slug, str(flags.repo));
  appendNote(state, note);
  appendEvent(state, { kind: "note", text: note });
  log(`Noted for later steps in ${slug}.`);
  return 0;
};

const cmdBarrel = async (positional: string[], flags: Record<string, string | true>): Promise<number> => {
  let state: RunState;
  const ipFlag = str(flags.ip);
  if (ipFlag) {
    const repo = await repoRoot(str(flags.repo) ?? process.cwd());
    const ip = isAbsolute(ipFlag) ? ipFlag : join(repo, ipFlag);
    const slug = str(flags.slug) ?? basename(ip, ".md").replace(/^\d{4}-\d{2}-\d{2}-/, "");
    state = existsSync(join(repo, ".terreno", "brewery", slug, "state.json"))
      ? loadState(slug, repo)
      : newState({ slug, repo, ip, base: await defaultBase(repo), phase: "approved" });
  } else {
    if (!positional[0]) throw new Error("usage: brewery barrel <slug> | --ip <path>");
    state = loadState(positional[0], str(flags.repo));
  }
  return withRunLock(state, async () => {
    saveState(state);
    const ctx = makeCtx(state, str(flags.agents), flags.parallel);
    const result = await barrel(ctx, githubCi);
    return result === "done" ? 0 : replyLoop(ctx, !flags["no-wait"], true);
  });
};

const cmdFinish = async (positional: string[], flags: Record<string, string | true>): Promise<number> => {
  const repo = await repoRoot(str(flags.repo) ?? process.cwd());
  await ensureExcluded(repo);
  const slugFlag = str(flags.slug);
  const pr = positional[0] ? Number(positional[0]) : ((await githubCi.prForBranch(repo)) ?? undefined);
  if (!pr) throw new Error("brewery finish: no PR given and none for the current branch");
  const slug = slugFlag ?? `pr-${pr}`;
  const state = existsSync(join(repo, ".terreno", "brewery", slug, "state.json"))
    ? loadState(slug, repo)
    : newState({ slug, repo, ip: "", base: await defaultBase(repo), phase: "finish" });
  return withRunLock(state, async () => {
    state.waiting = undefined;
    const ctx = makeCtx(state, str(flags.agents), flags.parallel);
    const result = await finish(ctx, githubCi, pr);
    return result === "done" ? 0 : replyLoop(ctx, !flags["no-wait"], true);
  });
};

const cmdResume = async (positional: string[], flags: Record<string, string | true>): Promise<number> => {
  const slug = positional[0];
  if (!slug || positional.length !== 1) throw new Error("usage: brewery resume <slug> [--go]");
  const state = loadState(slug, str(flags.repo));
  return withRunLock(state, async () => {
    const ctx = makeCtx(state, str(flags.agents), flags.parallel);
    if (state.waiting) return replyLoop(ctx, !flags["no-wait"], Boolean(flags.go));
    if (state.phase === "distill" || state.phase === "signoff") {
      if (!state.request) throw new Error(`brewery: ${slug} has no saved request to resume`);
      await distill(ctx, state.request);
      return replyLoop(ctx, !flags["no-wait"], Boolean(flags.go));
    }
    if (state.phase === "done") return 0;
    if (state.phase === "finish") {
      const result = await finish(ctx, githubCi);
      return result === "done" ? 0 : replyLoop(ctx, !flags["no-wait"], true);
    }
    const result = await barrel(ctx, githubCi);
    return result === "done" ? 0 : replyLoop(ctx, !flags["no-wait"], true);
  });
};

const cmdCut = async (positional: string[], flags: Record<string, string | true>): Promise<number> => {
  if (!positional[0]) throw new Error("usage: brewery cut <ip> [--request text | --context file]");
  const repo = await repoRoot(str(flags.repo) ?? process.cwd());
  await ensureExcluded(repo);
  const ip = isAbsolute(positional[0]) ? positional[0] : join(repo, positional[0]);
  const slug = `cut-${basename(ip, ".md")}`;
  const state = newState({ slug, repo, ip, base: await defaultBase(repo), phase: "distill" });
  const context = str(flags.context) ? readFileSync(str(flags.context) as string, "utf8") : str(flags.request);
  return withRunLock(state, async () => {
    if (context) appendContext(state, "What the human said", context);
    saveState(state);
    const findings = await runCut(makeCtx(state, str(flags.agents), flags.parallel));
    log(`\nCut: ${findings.length} findings (${findings.filter((f) => f.severity === "blocking").length} blocking) on ${relative(repo, ip)}, context: ${context ? "provided" : "ticket+Decisions"}\n`);
    log(findingsTable(findings));
    return 0;
  });
};

const cmdStatus = (positional: string[]): number => {
  const index = readIndex();
  const slugs = positional[0] ? [positional[0]] : Object.keys(index);
  if (!slugs.length) log("No brewery runs yet.");
  for (const slug of slugs) {
    let state: RunState;
    try {
      state = loadState(slug);
    } catch {
      log(`${slug.padEnd(32)} (state missing in ${index[slug]})`);
      continue;
    }
    const tasks = Object.values(state.tasks);
    const passed = tasks.filter((t) => t.status === "passed").length;
    let ipInfo = "";
    if (state.ip && existsSync(state.ip)) {
      const text = readIp(state.ip);
      ipInfo = ` ${passed}/${parseTasks(text).length} tasks, IP ${isApproved(text) ? "approved" : (readStatus(text) ?? "?")}`;
    }
    const running = Object.entries(state.tasks).filter(([, t]) => t.status === "running").map(([id]) => id);
    const active = running.length ? `  running ${running.join(", ")}` : "";
    const wait = state.waiting ? `  ⚑ waiting on you (${state.waiting.kind}) since ${state.waiting.since.slice(0, 16)}` : "";
    log(`${slug.padEnd(32)} ${state.phase.padEnd(9)}${state.pr ? ` PR #${state.pr}` : ""}${ipInfo}  ${basename(state.repo)}${active}${wait}`);
    if (positional[0] && state.waiting) log(`\n${state.waiting.message}`);
  }
  return 0;
};

const cmdAgents = async (flags: Record<string, string | true>): Promise<number> => {
  const repo = str(flags.repo) ?? process.cwd();
  const config = loadConfig(repo, str(flags.agents));
  log("Agents:");
  for (const [name, profile] of Object.entries(config.agents)) {
    const problem = await availability(profile);
    const detail = [profile.type, profile.model, profile.provider?.baseUrl].filter(Boolean).join(" ");
    log(`  ${problem ? "✗" : "✓"} ${name.padEnd(10)} ${detail}${problem ? `  (${problem})` : ""}`);
  }
  log("\nStages:");
  for (const stage of STAGES) {
    log(`  ${stage.padEnd(8)} ${FAN_OUT.has(stage) ? "all of" : "first of"} ${config.stages[stage].join(", ")}`);
  }
  return 0;
};

const main = async (): Promise<number> => {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "note" || command === "answer") {
    const parsed = parseArgs(rest.slice(2));
    if (parsed.positional.length) throw new Error(`usage: brewery ${command} <slug> "<text>"`);
    return command === "note" ? cmdNote(rest.slice(0, 2), parsed.flags) : cmdAnswer(rest.slice(0, 2), parsed.flags);
  }
  const { positional, flags } = parseArgs(rest);
  switch (command) {
    case "distill":
      return cmdDistill(positional, flags);
    case "answer":
      return cmdAnswer(positional, flags);
    case "resume":
      return cmdResume(positional, flags);
    case "barrel":
      return cmdBarrel(positional, flags);
    case "finish":
      return cmdFinish(positional, flags);
    case "cut":
      return cmdCut(positional, flags);
    case "status":
      return cmdStatus(positional);
    case "agents":
      return cmdAgents(flags);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      log(HELP);
      return 0;
    default:
      console.error(`brewery: unknown command "${command}"\n\n${HELP}`);
      return 1;
  }
};

main()
  .then((code) => process.exit(code))
  .catch((error: Error) => {
    if (activeState) appendEvent(activeState, { kind: "error", message: error.message });
    console.error(error.message);
    process.exit(1);
  });
