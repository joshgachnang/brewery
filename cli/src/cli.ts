#!/usr/bin/env bun
// brewery — run distill → cut → sign-off → barrel → finish as separate agent processes.
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { availability } from "./agents.ts";
import { buildBoard, gatherBoard, renderBoard } from "./board.ts";
import { appendEvent } from "./events.ts";
import { answer } from "./commands/answer.ts";
import { approve, basePolicy, gitReaders, waitForOtherChecks, type Poster } from "./commands/approve.ts";
import { githubPoster } from "./approve/github.ts";
import { installationToken } from "./approve/token.ts";
import { calibrate } from "./commands/calibrate.ts";
import { cellar } from "./commands/cellar.ts";
import { barrel } from "./commands/barrel.ts";
import { findingsTable, runCut } from "./commands/cut.ts";
import { defaultIpPath, distill, pour } from "./commands/distill.ts";
import { finish } from "./commands/finish.ts";
import { FAN_OUT, loadConfig, STAGES, userConfigPath } from "./config.ts";
import { initDocs } from "./docs.ts";
import { githubForge } from "./forge.ts";
import { readReplyFromTty } from "./human.ts";
import { isApproved, parseTasks, readIp, readStatus } from "./ip.ts";
import { appendContext, appendNote, loadState, newState, readIndex, saveState, slugify, withRunLock, type RunState } from "./state.ts";
import type { Ctx } from "./step.ts";
import { defaultBase, ensureExcluded, githubCi, repoRoot, sh } from "./vcs.ts";

const HELP = `brewery — plan and ship a feature with separate agents per step.

Usage:
  brewery distill "<request>" [--file req.md] [--slug s] [--ip path] [--go]
      Write the IP, attack it with cut, fix it, and send it for sign-off.
  brewery pour "<request>" [--file req.md] [--slug s] [--ip path]
      One shot for a small feature: write the IP and its task list, cut it, and, when it
      has no fundamental question and at most limits.pourMaxTasks tasks, approve it and
      build it: tests first, pick, roast, integrated roast, review, PR, finish. Otherwise
      it asks you first, here or over ntfy, and continues after your answer.
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
  brewery approve <pr> [--dry-run] [--base <branch>] [--wait-checks [min]]
      Review one PR head against the repo's rubric (.brewery.json approve block, read
      from the base branch) and post one review as the terreno-approval-agent GitHub App:
      APPROVE when the risk level is allowed, COMMENT otherwise, plus a check run.
      --dry-run prints the verdict and the review body without posting. --wait-checks
      waits (default limits.ciWaitMin) for every other check on the head to finish
      and skips the head, model unspent, when any failed or is still pending.
  brewery calibrate <owner/name> [--since <ISO date>] [--reviewer login,...] [--notes file] [--dry-run]
      Read what humans said in PR reviews since the last pass (and any pasted notes),
      and open one PR that turns the recurring ones into approval rubric rules and
      path rules. Prints generic proposals for brewery's default rubric.
  brewery cut <ip> [--request "text" | --context file]
      Attack an IP with only the human's words; prints findings.
  brewery cellar <owner/name> [--since <ISO date>] [--dry-run]
      Learn from one repo's journals, failed CI runs, and merged PRs since the last
      pass, and open one PR with learnings, rules, or checks. Meant for a nightly timer.
  brewery init-docs            Add docs/{decisions,journal,learnings}/ and point AGENTS.md/CLAUDE.md at them
  brewery status [slug]        Runs, phases, and what is waiting on you
  brewery board [--merges N] [--json]
      This repo's board from its IPs and runs: in progress, blocked, next up, recent merges.
  brewery agents               Agent profiles, availability, and stage routing
  brewery help

Common flags:
  --agents stage=a+b,...   Override routing, e.g. pick=claude,roast=claude+codex+local
  --repo <dir>             Target repository (default: current directory)
  --no-wait                Never read a reply from the terminal
  --go                     After approval, keep going into barrel
  --parallel N             Max concurrent task builds for this run (1 = sequential)

Config: ${userConfigPath()} and <repo>/.brewery.json.
Exit codes: 0 done or approved, 3 waiting on the human, 4 cellar or calibrate proposed
more changes than allowed (no PR), 1 error.`;

const WAITING = 3;

// The App identity for posting. A dry run only needs the login, for the skip gates.
const appAuth = async (repo: string, dryRun: boolean): Promise<{ poster?: Poster; appLogin?: string }> => {
  const env = process.env;
  if (dryRun) {
    const slug = env.TERRENO_APP_SLUG;
    return { appLogin: slug ? (slug.endsWith("[bot]") ? slug : `${slug}[bot]`) : undefined };
  }
  const name = (await sh(repo, ["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])).out;
  if (!name) throw new Error("brewery approve: cannot resolve owner/name for this repository (gh repo view)");
  const auth = await installationToken({ repo: name, env });
  return { poster: githubPoster({ repo: name, token: auth.token, appLogin: auth.appLogin, log }), appLogin: auth.appLogin };
};

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
    else if (["go", "no-wait", "here", "dry-run", "json"].includes(name) || next === undefined || next.startsWith("--") || (name === "wait-checks" && !/^\d+$/.test(next))) flags[name] = true;
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
  if (!go && !ctx.state.oneShot) return 0;
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

const cmdPour = async (positional: string[], flags: Record<string, string | true>): Promise<number> => {
  const file = str(flags.file);
  const request = file ? readFileSync(file, "utf8") : positional.join(" ");
  if (!request.trim()) throw new Error('brewery pour needs a request: brewery pour "<request>"');
  const repo = await repoRoot(str(flags.repo) ?? process.cwd());
  await ensureExcluded(repo);
  const slug = str(flags.slug) ?? slugify(request);
  const ipFlag = str(flags.ip);
  const ip = ipFlag ? (isAbsolute(ipFlag) ? ipFlag : join(repo, ipFlag)) : defaultIpPath(repo, slug);
  const state = newState({ slug, repo, ip, base: await defaultBase(repo), phase: "distill" });
  state.oneShot = true;
  return withRunLock(state, async () => {
    const ctx = makeCtx(state, str(flags.agents), flags.parallel);
    log(`brewery pour ${slug} in ${repo}`);
    if ((await pour(ctx, request)) === "approved") return afterApproval(ctx, true);
    return replyLoop(ctx, !flags["no-wait"], true);
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

const cmdApprove = async (positional: string[], flags: Record<string, string | true>): Promise<number> => {
  const repo = await repoRoot(str(flags.repo) ?? process.cwd());
  await ensureExcluded(repo);
  const pr = positional[0] ? Number(positional[0]) : ((await githubCi.prForBranch(repo)) ?? undefined);
  if (!pr || !Number.isSafeInteger(pr)) throw new Error("usage: brewery approve <pr> [--dry-run] [--base <branch>]");
  let view = await githubCi.prView(repo, pr);
  const base = str(flags.base) ?? view.base;
  const state = newState({ slug: `approve-${pr}`, repo, ip: "", base, phase: "build" });
  const dryRun = Boolean(flags["dry-run"]);
  const waitFlag = flags["wait-checks"];
  return withRunLock(state, async () => {
    saveState(state);
    const ctx = makeCtx(state, str(flags.agents), flags.parallel);
    if (waitFlag !== undefined) {
      const policy = await basePolicy(gitReaders(repo, base, view.headSha));
      const minutes = typeof waitFlag === "string" ? Number(waitFlag) : ctx.config.limits.ciWaitMin;
      if (!Number.isFinite(minutes) || minutes < 0) throw new Error(`brewery approve: --wait-checks wants minutes, got "${waitFlag}"`);
      const waited = await waitForOtherChecks(githubCi, repo, pr, policy, { minutes, log });
      if (waited.headChanged) return 0;
      view = waited.view;
    }
    const auth = await appAuth(repo, dryRun);
    const outcome = await approve(ctx, { ci: githubCi, ...gitReaders(repo, base, view.headSha), poster: auth.poster }, pr, { dryRun, view, appLogin: auth.appLogin, requireChecks: waitFlag !== undefined });
    if (outcome.verdict) log(`\n${JSON.stringify({ level: outcome.verdict.level, approve: outcome.verdict.approve, reasons: outcome.verdict.reasons, dimensions: outcome.verdict.dimensions, findings: outcome.verdict.findings, gates: outcome.verdict.gates, classification: outcome.verdict.classification }, null, 2)}`);
    log(`\n${outcome.body}`);
    return 0;
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

const cmdCellar = async (positional: string[], flags: Record<string, string | true>): Promise<number> => {
  if (!positional[0]) throw new Error("usage: brewery cellar <owner/name> [--since <ISO date>] [--dry-run]");
  const outcome = await cellar(positional[0], githubForge, { since: str(flags.since), dryRun: Boolean(flags["dry-run"]), log });
  return outcome.status === "too-many" ? 4 : 0;
};

const cmdCalibrate = async (positional: string[], flags: Record<string, string | true>): Promise<number> => {
  if (!positional[0]) throw new Error("usage: brewery calibrate <owner/name> [--since <ISO date>] [--reviewer login,...] [--notes file] [--dry-run]");
  const notesFile = str(flags.notes);
  const outcome = await calibrate(positional[0], githubForge, {
    since: str(flags.since),
    reviewers: (str(flags.reviewer) ?? "").split(",").map((r) => r.trim().replace(/^@/, "")).filter(Boolean),
    notes: notesFile ? readFileSync(notesFile, "utf8") : undefined,
    dryRun: Boolean(flags["dry-run"]),
    log,
  });
  return outcome.status === "too-many" || outcome.status === "disallowed" ? 4 : 0;
};

const cmdInitDocs = async (flags: Record<string, string | true>): Promise<number> => {
  const repo = await repoRoot(str(flags.repo) ?? process.cwd());
  const changed = initDocs(repo);
  log(changed.length ? `Created or updated:\n${changed.map((p) => `  ${p}`).join("\n")}` : "Docs layout already in place.");
  return 0;
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

const cmdBoard = async (flags: Record<string, string | true>): Promise<number> => {
  const repo = await repoRoot(str(flags.repo) ?? process.cwd());
  const merges = str(flags.merges) ? Number(str(flags.merges)) : 10;
  if (!Number.isSafeInteger(merges) || merges < 0) throw new Error("brewery board: --merges needs a non-negative integer");
  const config = loadConfig(repo);
  const board = buildBoard(await gatherBoard(repo, { base: await defaultBase(repo), planDirs: config.approve.planDirs, merges }));
  log(flags.json ? JSON.stringify(board, null, 2) : renderBoard(board));
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
    const stronger = config.escalate[stage]?.length ? `  (escalates to ${config.escalate[stage]!.join(", ")})` : "";
    log(`  ${stage.padEnd(8)} ${FAN_OUT.has(stage) ? "all of" : "first of"} ${config.stages[stage].join(", ")}${stronger}`);
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
    case "pour":
      return cmdPour(positional, flags);
    case "answer":
      return cmdAnswer(positional, flags);
    case "resume":
      return cmdResume(positional, flags);
    case "barrel":
      return cmdBarrel(positional, flags);
    case "finish":
      return cmdFinish(positional, flags);
    case "approve":
      return cmdApprove(positional, flags);
    case "cut":
      return cmdCut(positional, flags);
    case "cellar":
      return cmdCellar(positional, flags);
    case "calibrate":
      return cmdCalibrate(positional, flags);
    case "init-docs":
      return cmdInitDocs(flags);
    case "status":
      return cmdStatus(positional);
    case "board":
      return cmdBoard(flags);
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
