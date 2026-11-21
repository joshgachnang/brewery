#!/usr/bin/env bun
// forge — one CLI for pull requests, CI runs, issues and repos on GitHub and Forgejo. The forge
// is picked from the repo's host: github.com runs `gh`, a host in ~/.config/forge/hosts.json
// uses the Forgejo API. See cli/README.md ("forge") for commands, the JSON schema and hosts.json.
import { readFileSync } from "node:fs";
import { forgejoBackend } from "./forgejo.ts";
import { githubBackend } from "./github.ts";
import { printJson } from "./output.ts";
import { resolveRepo, type Resolved } from "./resolve.ts";
import { checksExitCode, checksState } from "./rules.ts";
import { ForgeError, type Backend, type Check, type Pr, type Run } from "./types.ts";

const HELP = `forge — pull requests, runs, issues and repos on GitHub (via gh) and Forgejo (via its API).

Usage:
  forge pr view [<number>|<url>|<branch>] [--comments]
  forge pr list [--state open|closed|merged|all] [--head b] [--base b] [--author login] [--label l] [--limit n] [--search q]
  forge pr create --title t (--body b | --body-file f) [--base b] [--head b] [--draft]
  forge pr diff [<pr>]
  forge pr checks [<pr>] [--watch] [--interval s] [--fail-fast] [--grace s]
  forge pr merge [<pr>] [--merge|--squash|--rebase] [--match-head-commit sha] [--delete-branch]
  forge pr comment [<pr>] (--body b | --body-file f)
  forge pr threads [<pr>] [--unresolved]
  forge pr ready [<pr>] [--undo]
  forge pr edit [<pr>] [--title t] [--body b | --body-file f] [--add-reviewer a,b] [--remove-reviewer a]
                [--add-label a,b] [--remove-label a]
  forge pr review [<pr>] (--approve | --request-changes | --comment) [--body b | --body-file f]
  forge run list [--branch b] [--commit sha] [--workflow w] [--status s] [--event e] [--created >=date] [--limit n]
  forge run view <id|url> [--log | --log-failed] [--job id]
  forge run watch <id|url> [--interval s] [--exit-status]
  forge run rerun <id|url> [--failed] [--job id]
  forge run logs <id|url> [--failed] [--job id]
  forge issue list [--state open|closed|all] [--label l] [--limit n] [--search q]
  forge issue view <number|url>
  forge issue close <number|url> [--comment c] [--reason r]
  forge issue comment <number|url> (--body b | --body-file f)
  forge issue label <number|url> [--add a,b] [--remove c]
  forge issue create --title t (--body b | --body-file f) [--label a] [--assignee login]
  forge label create <name> [--color hex] [--description d] [--force]
  forge repo view [<repo>]
  forge repo clone <repo> [<dir>] [-- <git clone flags>]
  forge api <path> [-X method] [-f k=v] [-F k=v] [--input file] [--paginate] [-q expr]

Every command takes -R/--repo OWNER/REPO, HOST/OWNER/REPO or a URL (default: the origin
remote). View, list, checks and threads take --json [field,...] and -q/--jq <expr>.
pr checks exits 0 when green, 1 when red or there are no checks, 8 while running.
`;

interface FlagSpec {
  alias?: string;
  value?: boolean;
  multi?: boolean;
}

const COMMON: Record<string, FlagSpec> = {
  repo: { alias: "R", value: true },
  help: { alias: "h" },
};

const OUTPUT: Record<string, FlagSpec> = { json: {}, jq: { alias: "q", value: true } };

const SPECS: Record<string, Record<string, FlagSpec>> = {
  "pr view": { ...OUTPUT, comments: { alias: "c" } },
  "pr list": { ...OUTPUT, state: { alias: "s", value: true }, head: { alias: "H", value: true }, base: { alias: "B", value: true }, author: { alias: "A", value: true }, label: { alias: "l", value: true }, limit: { alias: "L", value: true }, search: { alias: "S", value: true } },
  "pr create": { ...OUTPUT, title: { alias: "t", value: true }, body: { alias: "b", value: true }, "body-file": { alias: "F", value: true }, base: { alias: "B", value: true }, head: { alias: "H", value: true }, draft: { alias: "d" } },
  "pr diff": {},
  "pr checks": { ...OUTPUT, watch: {}, interval: { alias: "i", value: true }, "fail-fast": {}, grace: { value: true } },
  "pr merge": { merge: { alias: "m" }, squash: { alias: "s" }, rebase: { alias: "r" }, "match-head-commit": { value: true }, "match-head": { value: true }, "delete-branch": { alias: "d" } },
  "pr comment": { body: { alias: "b", value: true }, "body-file": { alias: "F", value: true } },
  "pr threads": { ...OUTPUT, unresolved: {} },
  "pr ready": { undo: {} },
  "pr edit": { title: { alias: "t", value: true }, body: { alias: "b", value: true }, "body-file": { alias: "F", value: true }, "add-reviewer": { value: true, multi: true }, "remove-reviewer": { value: true, multi: true }, "add-label": { value: true, multi: true }, "remove-label": { value: true, multi: true } },
  "pr review": { approve: { alias: "a" }, "request-changes": { alias: "r" }, comment: { alias: "c" }, body: { alias: "b", value: true }, "body-file": { alias: "F", value: true } },
  "run list": { ...OUTPUT, branch: { alias: "b", value: true }, commit: { alias: "c", value: true }, workflow: { alias: "w", value: true }, status: { alias: "s", value: true }, event: { alias: "e", value: true }, created: { value: true }, limit: { alias: "L", value: true } },
  "run view": { ...OUTPUT, log: {}, "log-failed": {}, job: { alias: "j", value: true } },
  "run watch": { interval: { alias: "i", value: true }, "exit-status": {} },
  "run rerun": { failed: {}, job: { alias: "j", value: true } },
  "run logs": { failed: {}, job: { alias: "j", value: true } },
  "issue list": { ...OUTPUT, state: { alias: "s", value: true }, label: { alias: "l", value: true }, limit: { alias: "L", value: true }, search: { alias: "S", value: true } },
  "issue view": { ...OUTPUT },
  "issue close": { comment: { alias: "c", value: true }, reason: { alias: "r", value: true } },
  "issue comment": { body: { alias: "b", value: true }, "body-file": { alias: "F", value: true } },
  "issue label": { ...OUTPUT, add: { value: true, multi: true }, remove: { value: true, multi: true } },
  "issue create": { title: { alias: "t", value: true }, body: { alias: "b", value: true }, "body-file": { alias: "F", value: true }, label: { alias: "l", value: true, multi: true }, assignee: { alias: "a", value: true, multi: true } },
  "label create": { color: { alias: "c", value: true }, description: { alias: "d", value: true }, force: { alias: "f" } },
  "repo view": { ...OUTPUT },
  "repo clone": {},
};

export interface Parsed {
  flags: Record<string, string | boolean | string[]>;
  positional: string[];
  rest: string[];
  // --json's field list; [] means every field, null means no --json.
  fields: string[] | null;
}

const FIELD_LIST = /^[A-Za-z][A-Za-z,]*$/;

export const parseArgs = (args: string[], spec: Record<string, FlagSpec>): Parsed => {
  const all = { ...COMMON, ...spec };
  const byAlias = new Map(Object.entries(all).filter(([, s]) => s.alias).map(([name, s]) => [s.alias as string, name]));
  const out: Parsed = { flags: {}, positional: [], rest: [], fields: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      out.rest = args.slice(i + 1);
      break;
    }
    const long = arg.match(/^--([a-z][a-z-]*)(?:=(.*))?$/);
    const short = arg.match(/^-([A-Za-z])$/);
    if (!long && !short) {
      out.positional.push(arg);
      continue;
    }
    const name = long ? long[1] : byAlias.get(short?.[1] ?? "");
    const inline = long?.[2];
    const flag = name ? all[name] : undefined;
    if (!name || !flag) throw new ForgeError(`forge: unknown flag ${arg}`);
    if (name === "json") {
      const next = inline ?? (args[i + 1] !== undefined && FIELD_LIST.test(args[i + 1]) ? args[++i] : undefined);
      out.fields = next ? next.split(",").filter(Boolean) : [];
      continue;
    }
    if (!flag.value) {
      out.flags[name] = true;
      continue;
    }
    const value = inline ?? args[++i];
    if (value === undefined) throw new ForgeError(`forge: ${arg} needs a value`);
    if (flag.multi) out.flags[name] = [...((out.flags[name] as string[] | undefined) ?? []), value];
    else out.flags[name] = value;
  }
  return out;
};

const str = (p: Parsed, name: string): string | undefined => (typeof p.flags[name] === "string" ? (p.flags[name] as string) : undefined);
const bool = (p: Parsed, name: string): boolean => p.flags[name] === true;
const num = (p: Parsed, name: string, fallback: number): number => {
  const v = str(p, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ForgeError(`forge: --${name} must be a number`);
  return n;
};
const list = (p: Parsed, name: string): string[] =>
  ((p.flags[name] as string[] | undefined) ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);

const bodyOf = (p: Parsed): string => {
  const file = str(p, "body-file");
  if (file !== undefined) return readFileSync(file === "-" ? 0 : file, "utf8");
  const body = str(p, "body");
  if (body === undefined) throw new ForgeError("forge: --body or --body-file is required");
  return body;
};

const wantsJson = (p: Parsed): boolean => p.fields !== null || str(p, "jq") !== undefined;

const output = async (p: Parsed, value: unknown, text: () => string): Promise<void> => {
  if (wantsJson(p)) await printJson(value, p.fields && p.fields.length ? p.fields : null, str(p, "jq"));
  else process.stdout.write(`${text()}\n`);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const short = (sha: string): string => sha.slice(0, 7);

const prText = (pr: Pr): string =>
  [
    `#${pr.number} ${pr.title} [${pr.state}${pr.isDraft ? ", draft" : ""}] (${pr.forge})`,
    pr.url,
    `${pr.headRefName} (${short(pr.headRefOid)}) -> ${pr.baseRefName}  by ${pr.author.login}`,
    `checks: ${pr.checksState} (${pr.checks.length})  review: ${pr.reviewDecision}  mergeable: ${pr.mergeable}`,
  ].join("\n");

// pr view --comments: the conversation, then each review that said something, oldest first.
const conversation = (pr: Pr): string => {
  const items = [
    ...pr.comments.map((c) => ({ at: c.createdAt, head: `${c.author.login} commented`, body: c.body })),
    ...pr.reviews.filter((r) => r.body || r.state !== "COMMENTED").map((r) => ({ at: r.submittedAt, head: `${r.author.login} reviewed: ${r.state}`, body: r.body })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return items.length ? items.map((i) => `--- ${i.head} (${i.at})\n${i.body}`.trimEnd()).join("\n\n") : "no comments";
};

const checksText = (checks: Check[]): string =>
  checks.length ? checks.map((c) => [c.name, c.bucket, c.description, c.link].join("\t")).join("\n") : "no checks reported";

const runText = (run: Run): string =>
  [
    `${run.workflowName} #${run.number}: ${run.displayTitle}`,
    run.url,
    `${run.headBranch} (${short(run.headSha)})  ${run.event}  ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ""}`,
    ...run.jobs.map((j) => `  ${j.name}\t${j.status}${j.conclusion ? ` / ${j.conclusion}` : ""}\t${j.databaseId}`),
  ].join("\n");

export const backendFor = (resolved: Resolved, cwd: string, env: NodeJS.ProcessEnv): Backend =>
  resolved.ref.forge === "github"
    ? githubBackend(resolved.ref, { cwd })
    : forgejoBackend(resolved.ref, {
      entry: resolved.entry!,
      token: resolved.token,
      cwd,
      pollMs: env.FORGE_POLL_MS ? Number(env.FORGE_POLL_MS) : undefined,
    });

const watchChecks = async (b: Backend, sel: string | undefined, p: Parsed): Promise<number> => {
  const interval = num(p, "interval", 10) * 1000;
  const graceEnd = Date.now() + num(p, "grace", 0) * 1000;
  let last = "";
  for (;;) {
    const checks = await b.prChecks(sel);
    const state = checksState(checks);
    const line = `${state}: ${checks.filter((c) => c.bucket === "pass").length} pass, ${checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel").length} fail, ${checks.filter((c) => c.bucket === "pending").length} pending`;
    if (line !== last && !wantsJson(p)) console.error(line);
    last = line;
    // Like gh: wait until nothing is pending, or (with --fail-fast) until anything fails.
    const pending = checks.some((c) => c.bucket === "pending");
    const failed = checks.some((c) => c.bucket === "fail" || c.bucket === "cancel");
    const done = state === "none" ? Date.now() >= graceEnd : !pending || (bool(p, "fail-fast") && failed);
    if (done) {
      if (wantsJson(p)) await output(p, checks, () => "");
      else process.stdout.write(`${checksText(checks)}\n`);
      return checksExitCode(state);
    }
    await sleep(interval);
  }
};

const watchRun = async (b: Backend, id: string, p: Parsed): Promise<number> => {
  const interval = num(p, "interval", 10) * 1000;
  let last = "";
  for (;;) {
    const run = await b.runView(id);
    const line = `${run.status}${run.conclusion ? ` / ${run.conclusion}` : ""}  ${run.jobs.map((j) => `${j.name}=${j.conclusion || j.status}`).join(" ")}`;
    if (line !== last) console.error(line);
    last = line;
    if (run.status === "completed") {
      process.stdout.write(`${runText(run)}\n`);
      return bool(p, "exit-status") && run.conclusion !== "success" && run.conclusion !== "skipped" ? 1 : 0;
    }
    await sleep(interval);
  }
};

const need = (value: string | undefined, what: string): string => {
  if (!value) throw new ForgeError(`forge: ${what} is required`);
  return value;
};

export const main = async (argv: string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Promise<number> => {
  const [group, verb, ...args] = argv;
  if (!group || group === "help" || group === "--help" || group === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (group === "api") {
    // -R is ours; everything else goes to `gh api` or the Forgejo client untouched.
    const rest = [verb, ...args].filter((a) => a !== undefined);
    let repo: string | undefined;
    const passthrough: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "-R" || rest[i] === "--repo") repo = rest[++i];
      else passthrough.push(rest[i]);
    }
    const resolved = await resolveRepo({ repo, cwd, env });
    if (resolved.ref.forge === "github") {
      const proc = Bun.spawn(["gh", "api", ...passthrough], { cwd, env: { ...env, GH_REPO: `${resolved.ref.owner}/${resolved.ref.name}` }, stdio: ["inherit", "inherit", "inherit"] });
      return proc.exited;
    }
    return backendFor(resolved, cwd, env).api(passthrough);
  }
  const key = `${group} ${verb ?? ""}`;
  const spec = SPECS[key];
  if (!spec) throw new ForgeError(`forge: unknown command "${key.trim()}"; run forge --help`);
  const p = parseArgs(args, spec);
  if (bool(p, "help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const first = p.positional[0];
  const repoArg = key === "repo view" || key === "repo clone" ? first : undefined;
  const resolved = await resolveRepo({ repo: str(p, "repo") ?? repoArg, urlArg: first, cwd, env });
  const b = backendFor(resolved, cwd, env);

  switch (key) {
    case "pr view": {
      const pr = await b.prView(first);
      await output(p, pr, () => (bool(p, "comments") ? `${prText(pr)}\n\n${conversation(pr)}` : prText(pr)));
      return 0;
    }
    case "pr list": {
      const state = (str(p, "state") ?? "open") as "open" | "closed" | "merged" | "all";
      if (!["open", "closed", "merged", "all"].includes(state)) throw new ForgeError("forge: --state is open, closed, merged or all");
      let prs = await b.prList({ state, limit: num(p, "limit", 30), head: str(p, "head"), base: str(p, "base"), author: str(p, "author"), label: str(p, "label"), search: str(p, "search") });
      // Checks and reviews cost a call per PR, so a list only fetches them when asked for.
      const deep = ["checks", "checksState", "reviews", "reviewDecision", "comments", "mergeable", "mergeStateStatus"];
      if (wantsJson(p) && (p.fields === null || p.fields.length === 0 || p.fields.some((f) => deep.includes(f)))) {
        prs = await Promise.all(prs.map((pr) => (pr.state === "OPEN" ? b.prView(String(pr.number)) : Promise.resolve(pr))));
      }
      await output(p, prs, () => prs.map((pr) => `#${pr.number}\t${pr.title}\t${pr.headRefName}\t${pr.state}`).join("\n") || "no pull requests");
      return 0;
    }
    case "pr create": {
      const head = str(p, "head") ?? (await Bun.$`git rev-parse --abbrev-ref HEAD`.cwd(cwd).quiet().text()).trim();
      const url = await b.prCreate({ title: need(str(p, "title"), "--title"), body: bodyOf(p), base: str(p, "base"), head, draft: bool(p, "draft") });
      if (wantsJson(p)) await output(p, await b.prView(url), () => url);
      else process.stdout.write(`${url}\n`);
      return 0;
    }
    case "pr diff":
      process.stdout.write(`${await b.prDiff(first)}\n`);
      return 0;
    case "pr checks": {
      if (bool(p, "watch")) return watchChecks(b, first, p);
      const checks = await b.prChecks(first);
      await output(p, checks, () => checksText(checks));
      return checksExitCode(checksState(checks));
    }
    case "pr merge": {
      const methods = (["merge", "squash", "rebase"] as const).filter((m) => bool(p, m));
      if (methods.length > 1) throw new ForgeError("forge: pick one of --merge, --squash, --rebase");
      await b.prMerge(first, { method: methods[0] ?? "merge", matchHead: str(p, "match-head-commit") ?? str(p, "match-head"), deleteBranch: bool(p, "delete-branch") });
      console.error(`merged ${first ?? "the current branch's pull request"}`);
      return 0;
    }
    case "pr comment":
      process.stdout.write(`${await b.prComment(first, bodyOf(p))}\n`);
      return 0;
    case "pr threads": {
      const threads = (await b.prThreads(first)).filter((t) => !bool(p, "unresolved") || !t.isResolved);
      await output(p, threads, () =>
        threads.map((t) => `${t.path}:${t.line ?? "?"}\t${t.isResolved ? "resolved" : "open"}\t${t.comments.length} comment(s)\t${t.comments[0]?.author.login}: ${(t.comments[0]?.body ?? "").split("\n")[0].slice(0, 80)}`).join("\n") || "no review threads");
      return 0;
    }
    case "pr ready":
      await b.prReady(first, bool(p, "undo"));
      console.error(bool(p, "undo") ? "converted to draft" : "marked ready for review");
      return 0;
    case "pr edit": {
      const body = str(p, "body") !== undefined || str(p, "body-file") !== undefined ? bodyOf(p) : undefined;
      const edit = { title: str(p, "title"), body, addReviewers: list(p, "add-reviewer"), removeReviewers: list(p, "remove-reviewer"), addLabels: list(p, "add-label"), removeLabels: list(p, "remove-label") };
      if (edit.title === undefined && body === undefined && !edit.addReviewers.length && !edit.removeReviewers.length && !edit.addLabels.length && !edit.removeLabels.length) {
        throw new ForgeError("forge: pr edit needs at least one of --title, --body, --body-file, --add-reviewer, --remove-reviewer, --add-label, --remove-label");
      }
      await b.prEdit(first, edit);
      return 0;
    }
    case "pr review": {
      const events = (["approve", "request-changes", "comment"] as const).filter((e) => bool(p, e));
      if (events.length !== 1) throw new ForgeError("forge: pick one of --approve, --request-changes, --comment");
      const body = str(p, "body") !== undefined || str(p, "body-file") !== undefined ? bodyOf(p) : "";
      const url = await b.prReview(first, events[0], body);
      if (url) process.stdout.write(`${url}\n`);
      return 0;
    }
    case "run list": {
      const runs = await b.runList({ limit: num(p, "limit", 20), branch: str(p, "branch"), commit: str(p, "commit"), workflow: str(p, "workflow"), status: str(p, "status"), event: str(p, "event"), created: str(p, "created") });
      await output(p, runs, () => runs.map((r) => [r.databaseId, r.status, r.conclusion || "-", r.workflowName, r.headBranch, r.displayTitle].join("\t")).join("\n") || "no runs");
      return 0;
    }
    case "run view": {
      const id = need(first, "a run id");
      if (bool(p, "log") || bool(p, "log-failed")) {
        process.stdout.write(`${await b.runLogs(id, { failed: bool(p, "log-failed"), job: str(p, "job") })}\n`);
        return 0;
      }
      const run = await b.runView(id);
      await output(p, run, () => runText(run));
      return 0;
    }
    case "run watch":
      return watchRun(b, need(first, "a run id"), p);
    case "run rerun":
      await b.runRerun(need(first, "a run id"), { failed: bool(p, "failed"), job: str(p, "job") });
      return 0;
    case "run logs":
      process.stdout.write(`${await b.runLogs(need(first, "a run id"), { failed: bool(p, "failed"), job: str(p, "job") })}\n`);
      return 0;
    case "issue list": {
      const state = (str(p, "state") ?? "open") as "open" | "closed" | "all";
      if (!["open", "closed", "all"].includes(state)) throw new ForgeError("forge: --state is open, closed or all");
      const issues = await b.issueList({ state, limit: num(p, "limit", 30), label: str(p, "label"), search: str(p, "search") });
      await output(p, issues, () => issues.map((i) => `#${i.number}\t${i.state}\t${i.title}\t${i.labels.map((l) => l.name).join(",")}`).join("\n") || "no issues");
      return 0;
    }
    case "issue view": {
      const issue = await b.issueView(need(first, "an issue number"));
      await output(p, issue, () => `#${issue.number} ${issue.title} [${issue.state}]\n${issue.url}\nlabels: ${issue.labels.map((l) => l.name).join(", ") || "-"}\n\n${issue.body}`);
      return 0;
    }
    case "issue close":
      await b.issueClose(need(first, "an issue number"), { comment: str(p, "comment"), reason: str(p, "reason") });
      return 0;
    case "issue comment":
      process.stdout.write(`${await b.issueComment(need(first, "an issue number"), bodyOf(p))}\n`);
      return 0;
    case "issue label": {
      const labels = await b.issueLabel(need(first, "an issue number"), list(p, "add"), list(p, "remove"));
      await output(p, labels.map((name) => ({ name })), () => labels.join("\n"));
      return 0;
    }
    case "issue create": {
      const url = await b.issueCreate({ title: need(str(p, "title"), "--title"), body: bodyOf(p), labels: list(p, "label"), assignees: list(p, "assignee") });
      process.stdout.write(`${url}\n`);
      return 0;
    }
    case "label create":
      await b.labelCreate({ name: need(first, "a label name"), color: str(p, "color") ?? "ededed", description: str(p, "description") ?? "", force: bool(p, "force") });
      return 0;
    case "repo view": {
      const repo = await b.repoView();
      await output(p, repo, () => `${repo.nameWithOwner} (${repo.forge})\n${repo.url}\ndefault branch: ${repo.defaultBranchRef.name}`);
      return 0;
    }
    case "repo clone":
      need(first, "a repo");
      await b.repoClone(p.positional[1], p.rest);
      return 0;
  }
  throw new ForgeError(`forge: unknown command "${key}"`);
};

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(error instanceof ForgeError ? error.code : 1);
  }
}
