// Launch one agent as its own process. Nothing is shared between calls except the
// repository and the files brewery hands over, so every step is a fresh context.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AgentProfile } from "./config.ts";
import { scrub, scrubSecrets } from "./scrub.ts";

export type Status = "PASS" | "FAIL" | "BLOCKED" | "PENDING";

export interface Ask {
  q: string;
  rec: string;
  opts?: string[];
  // A wrong guess would change the destination or most of the plan (distilling.md).
  fundamental?: boolean;
}

export interface Finding {
  id?: string;
  severity: "blocking" | "should-fix" | "nit";
  axis?: string;
  where?: string;
  attack: string;
  evidence: string;
  fix?: string;
  agent?: string;
}

// What every step writes to its result file. A superset of terreno's stage result.
export interface StepResult {
  status: Status;
  action: string;
  next?: string | null;
  summary?: string;
  ip?: string;
  pr?: number | string;
  sha?: string;
  ask?: Ask[];
  fail?: { need: string; want: string; got: string; ev: string }[];
  block?: { kind: "human" | "environment" | "access" | "external"; why: string; ev?: string }[];
  findings?: Finding[];
  // cut: what held up under attack, and what the attacker could not check
  wellReasoned?: string[];
  couldNotAssess?: string[];
  structural?: boolean;
  // compound: the repo-relative learning written or updated, or null when skipped
  learning?: string | null;
  // read-only steps: the JSON-schema answer from stdout
  structured?: unknown;
  tally?: { edited: number; moved: number; rebutted: number };
  // test: the repo-relative test files written, the command that runs only them, and
  // why the task has nothing to test when `tests` is empty
  tests?: string[];
  command?: string;
  untestable?: string;
  // pick: every change to a test the test step wrote, with the reason
  testChanges?: { file: string; why: string }[];
  // roast: the failure is in the tests themselves, so the test step runs again
  retest?: boolean;
  // writing steps: a short brief for whoever runs next, validated, capped, and scrubbed
  handoff?: Handoff;
}

export interface Handoff {
  did: string;
  learned: string[];
  traps: string[];
  files: string[];
}

const HANDOFF_DID_MAX = 400;
const HANDOFF_ITEM_MAX = 200;
const HANDOFF_ITEMS_MAX = 8;

const cap = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

// A malformed handoff is dropped rather than failing the step: it is advice, not a verdict.
// `files` keeps digits and dates, which full scrubbing would mangle in paths.
export const cleanHandoff = (raw: unknown): Handoff | undefined => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { did, learned = [], traps = [], files = [] } = raw as Record<string, unknown>;
  if (typeof did !== "string" || !did.trim()) return undefined;
  if (!isStrings(learned) || !isStrings(traps) || !isStrings(files)) return undefined;
  const list = (items: string[], clean: (text: string) => string): string[] =>
    items.slice(0, HANDOFF_ITEMS_MAX).map((item) => cap(clean(item), HANDOFF_ITEM_MAX));
  return {
    did: cap(scrub(did), HANDOFF_DID_MAX),
    learned: list(learned, scrub),
    traps: list(traps, scrub),
    files: list(files, scrubSecrets),
  };
};

export interface RunRequest {
  name: string;
  profile: AgentProfile;
  cwd: string;
  prompt: string;
  promptFile: string;
  resultFile: string;
  logFile: string;
  timeoutMin: number;
  onNarration?: (text: string) => void;
  // A verifier step: no edits, no hooks, an allowlisted environment, and a JSON-schema
  // answer on stdout instead of a result file. Used by `brewery approve`.
  readOnly?: ReadOnly;
}

export interface ReadOnly {
  schema: object;
  budgetUsd?: number;
}

export const READ_ONLY_TOOLS = "Read,Grep,Glob,Bash(git diff:*),Bash(git show:*),Bash(git log:*)";
const EDIT_TOOLS = "Edit,Write,NotebookEdit";
// Everything a read-only child may see. Credentials for GitHub and the App never appear.
const READ_ONLY_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "USER", "SHELL", "LANG", "TERM", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];

// Token and cost totals for one step, as the agent itself reported them. Each agent's
// own counts are kept: Claude's input excludes cache reads, Codex's input includes them.
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  costUsd?: number;
}

export interface RunOutcome {
  result: StepResult;
  exitCode: number | null;
  seconds: number;
  // Absent when the agent printed no usage records (command agents never do).
  usage?: Usage;
}

const tomlString = (value: string): string => JSON.stringify(value);

export const agentArgv = (profile: AgentProfile, cwd: string, readOnly?: ReadOnly, promptFile?: string): string[] => {
  switch (profile.type) {
    case "cursor":
      // Cursor's CLI takes the prompt as an argument, not stdin, and has no read-only mode
      // that returns schema-checked JSON. Point it at the prompt file instead of passing the
      // prompt itself, which keeps long prompts out of argv.
      if (readOnly) throw new Error("brewery: cursor cannot run read-only steps (approve, calibrate); route them to claude");
      return [
        profile.bin ?? "agent",
        "-p",
        "--force",
        "--trust",
        "--output-format",
        "stream-json",
        "--workspace",
        cwd,
        ...(profile.model ? ["--model", profile.model] : []),
        ...(profile.args ?? []),
        `Your instructions for this step are in ${promptFile ?? "$BREWERY_PROMPT_FILE"}. Read that whole file and follow it exactly.`,
      ];
    case "claude":
      return [
        "claude",
        "-p",
        ...(readOnly
          ? [
              "--bare",
              "--permission-mode", "dontAsk",
              "--allowedTools", READ_ONLY_TOOLS,
              "--disallowedTools", EDIT_TOOLS,
              "--output-format", "json",
              "--json-schema", JSON.stringify(readOnly.schema),
              ...(readOnly.budgetUsd ? ["--max-budget-usd", String(readOnly.budgetUsd)] : []),
            ]
          : ["--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"]),
        ...(profile.model ? ["--model", profile.model] : []),
        ...(profile.args ?? []),
      ];
    case "codex": {
      const provider = profile.provider;
      const providerArgs = provider
        ? [
            "-c",
            `model_provider=${tomlString(provider.name)}`,
            "-c",
            `model_providers.${provider.name}.name=${tomlString(provider.name)}`,
            "-c",
            `model_providers.${provider.name}.base_url=${tomlString(provider.baseUrl)}`,
            "-c",
            `model_providers.${provider.name}.env_key=${tomlString(provider.envKey)}`,
            "-c",
            `model_providers.${provider.name}.wire_api=${tomlString(provider.wireApi ?? "responses")}`,
          ]
        : [];
      return [
        "codex",
        "exec",
        "--json",
        ...(readOnly ? ["--sandbox", "read-only"] : ["--dangerously-bypass-approvals-and-sandbox"]),
        "--skip-git-repo-check",
        "-C",
        cwd,
        ...(profile.model ? ["-m", profile.model] : []),
        ...providerArgs,
        ...(profile.args ?? []),
        "-",
      ];
    }
    case "command":
      if (!profile.command?.length) throw new Error("brewery: command agent needs `command`");
      return profile.command;
  }
};

export const readOnlyEnv = (profile: AgentProfile, parent: Record<string, string | undefined>): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of [...READ_ONLY_ENV_KEYS, ...(profile.provider ? [profile.provider.envKey] : [])]) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
};

const childEnv = (profile: AgentProfile, req: RunRequest): Record<string, string> => {
  const env: Record<string, string> = {};
  if (req.readOnly) Object.assign(env, readOnlyEnv(profile, process.env));
  else {
    for (const [key, value] of Object.entries(process.env)) {
      // A nested claude must not think it is running inside the parent session.
      if (value !== undefined && key !== "CLAUDECODE" && !key.startsWith("CLAUDE_CODE_")) env[key] = value;
    }
  }
  return {
    ...env,
    ...profile.env,
    BREWERY_PROMPT_FILE: req.promptFile,
    BREWERY_RESULT_FILE: req.resultFile,
  };
};

// `claude -p --output-format json` prints one envelope; with --json-schema the answer is
// in `structured_output`. Codex and command agents may print the same envelope.
export const resultFromStdout = (stdout: string): StepResult => {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const envelope = record(parsed);
    if (!envelope) continue;
    if (envelope.is_error === true) {
      const why = typeof envelope.result === "string" ? envelope.result : "agent reported an error";
      return { status: "FAIL", action: `Rerun: ${why}`, fail: [{ need: "a structured answer", want: "structured_output", got: why, ev: "stdout" }] };
    }
    if (envelope.structured_output !== undefined && envelope.structured_output !== null) {
      return { status: "PASS", action: "returned structured output", structured: envelope.structured_output };
    }
  }
  return { status: "FAIL", action: "Rerun: no structured output on stdout", fail: [{ need: "a structured answer", want: "structured_output", got: stdout.slice(-300), ev: "stdout" }] };
};

const STATUSES: ReadonlySet<string> = new Set(["PASS", "FAIL", "BLOCKED", "PENDING"]);

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const oneLine = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 300) : "";

const toolSummary = (name: unknown, input: unknown): string => {
  if (typeof name !== "string") return "";
  const args = record(input);
  if (name === "Read" || name === "Write" || name === "Edit") {
    const path = args?.file_path;
    return oneLine(typeof path === "string" ? `${name} ${path.split("/").at(-1)}` : name);
  }
  if (name === "Bash") return oneLine(typeof args?.command === "string" ? `Bash: ${args.command}` : "Bash");
  return oneLine(name);
};

// Structured stdout is JSONL for Claude and Codex. Ignore lifecycle, user, result,
// and completed tool events so the feed has no duplicate messages or command output.
export const parseNarrationLine = (type: AgentProfile["type"], line: string): string[] => {
  if (type === "command") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const event = record(parsed);
  if (!event) return [];
  if (type === "claude" && event.type === "assistant") {
    const message = record(event.message);
    if (!Array.isArray(message?.content)) return [];
    return message.content.flatMap((raw: unknown) => {
      const block = record(raw);
      if (!block) return [];
      const text = block.type === "text" ? oneLine(block.text) :
        block.type === "tool_use" ? toolSummary(block.name, block.input) : "";
      return text ? [text] : [];
    });
  }
  if (type === "cursor") {
    // Streaming deltas carry no model_call_id; the buffered flush before each tool call does.
    if (event.type === "assistant" && event.model_call_id) {
      const message = record(event.message);
      if (!Array.isArray(message?.content)) return [];
      return message.content.flatMap((raw: unknown) => {
        const text = record(raw)?.type === "text" ? oneLine(record(raw)?.text) : "";
        return text ? [text] : [];
      });
    }
    if (event.type === "tool_call" && event.subtype === "started") {
      const call = record(event.tool_call);
      const write = record(call?.writeToolCall);
      const read = record(call?.readToolCall);
      const path = record((write ?? read)?.args)?.path;
      if (typeof path === "string") return [`${write ? "Edit" : "Read"} ${path.split("/").pop()}`];
      const name = call ? Object.keys(call)[0]?.replace(/ToolCall$/, "") : undefined;
      return name ? [name] : [];
    }
    return [];
  }
  if (type === "codex") {
    const item = record(event.item);
    if (!item) return [];
    if (event.type === "item.completed" && item.type === "agent_message") {
      const text = oneLine(item.text);
      return text ? [text] : [];
    }
    if (event.type === "item.started") {
      const text = item.type === "command_execution" ? toolSummary("Bash", { command: item.command }) :
        item.type === "file_change" ? "Edit files" :
        item.type === "mcp_tool_call" && typeof item.server === "string" && typeof item.tool === "string" ? oneLine(`MCP ${item.server}.${item.tool}`) :
        item.type === "web_search" && typeof item.query === "string" ? oneLine(`Search: ${item.query}`) :
        item.type === "dynamic_tool_call" ? oneLine(item.tool) : "";
      return text ? [text] : [];
    }
  }
  return [];
};

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

// Claude reports usage once, on its final `result` record; Codex reports it on every
// `turn.completed`. Other agents report nothing brewery can read.
export const parseUsageLine = (type: AgentProfile["type"], line: string): Usage | null => {
  if (type !== "claude" && type !== "codex") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const event = record(parsed);
  if (event?.type !== (type === "claude" ? "result" : "turn.completed")) return null;
  const usage = record(event.usage);
  const inputTokens = count(usage?.input_tokens);
  const outputTokens = count(usage?.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return null;
  const cacheReadTokens = count(type === "claude" ? usage?.cache_read_input_tokens : usage?.cached_input_tokens);
  const costUsd = type === "claude" ? count(event.total_cost_usd) : undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
};

const addUsage = (total: Usage | undefined, next: Usage): Usage => {
  if (!total) return next;
  const sum = (a?: number, b?: number): number | undefined => a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  const cacheReadTokens = sum(total.cacheReadTokens, next.cacheReadTokens);
  const costUsd = sum(total.costUsd, next.costUsd);
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
};

export const readResult = (resultFile: string): StepResult | string => {
  if (!existsSync(resultFile)) return "agent exited without writing its result file";
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resultFile, "utf8"));
  } catch (error) {
    return `result file is not JSON: ${(error as Error).message}`;
  }
  const result = raw as Partial<StepResult>;
  if (!result || typeof result !== "object") return "result is not an object";
  if (!STATUSES.has(String(result.status))) return `result status "${result.status}" is not PASS/FAIL/BLOCKED/PENDING`;
  if (typeof result.action !== "string" || !result.action) return "result has no action";
  if ("handoff" in result) {
    const { handoff, ...rest } = result;
    const clean = cleanHandoff(handoff);
    return (clean ? { ...rest, handoff: clean } : rest) as StepResult;
  }
  return result as StepResult;
};

export const availability = async (profile: AgentProfile): Promise<string | null> => {
  const argv = agentArgv(profile, process.cwd());
  const bin = Bun.which(argv[0]);
  if (!bin) return `${argv[0]} not on PATH`;
  if (profile.type === "command") return null;
  const proc = Bun.spawn([bin, "--version"], { stdout: "ignore", stderr: "ignore", timeout: 15_000 });
  if ((await proc.exited) !== 0) return `${argv[0]} --version failed (broken install?)`;
  if (profile.provider && !process.env[profile.provider.envKey]) return `${profile.provider.envKey} is not set`;
  return null;
};

export const runAgent = async (req: RunRequest): Promise<RunOutcome> => {
  rmSync(req.resultFile, { force: true });
  writeFileSync(req.promptFile, req.prompt);
  writeFileSync(req.logFile, `# ${req.name} in ${req.cwd}\n# prompt: ${req.promptFile}\n\n`);
  const started = Date.now();
  const proc = Bun.spawn(agentArgv(req.profile, req.cwd, req.readOnly, req.promptFile), {
    cwd: req.cwd,
    env: childEnv(req.profile, req),
    stdin: Bun.file(req.promptFile),
    stdout: "pipe",
    stderr: "pipe",
    timeout: req.timeoutMin * 60_000,
  });
  let stdoutText = "";
  let usage: Usage | undefined;
  // Every complete stdout line feeds both the narration feed and the usage totals.
  const stdoutLine = (line: string): void => {
    const lineUsage = parseUsageLine(req.profile.type, line);
    // Claude's result record is already the session total; Codex reports each turn.
    if (lineUsage) usage = req.profile.type === "codex" ? addUsage(usage, lineUsage) : lineUsage;
    if (!req.onNarration) return;
    for (const narration of parseNarrationLine(req.profile.type, line)) req.onNarration(narration);
  };
  const pump = async (stream: ReadableStream<Uint8Array>, isStdout: boolean): Promise<void> => {
    const decoder = new TextDecoder();
    let pending = "";
    const consume = (text: string): void => {
      appendFileSync(req.logFile, text);
      if (!isStdout) return;
      if (req.readOnly) stdoutText += text;
      pending += text;
      let boundary = pending.indexOf("\n");
      while (boundary !== -1) {
        stdoutLine(pending.slice(0, boundary));
        pending = pending.slice(boundary + 1);
        boundary = pending.indexOf("\n");
      }
    };
    for await (const chunk of stream) consume(decoder.decode(chunk, { stream: true }));
    consume(decoder.decode());
    if (isStdout && pending) stdoutLine(pending);
  };
  await Promise.all([pump(proc.stdout, true), pump(proc.stderr, false), proc.exited]);
  const seconds = Math.round((Date.now() - started) / 1000);
  const parsed = readResult(req.resultFile);
  const result: StepResult =
    typeof parsed === "string" && req.readOnly
      ? resultFromStdout(stdoutText)
      : typeof parsed === "string"
      ? {
          status: "FAIL",
          action: `Rerun ${req.name}: ${parsed}`,
          fail: [{ need: "a result file", want: req.resultFile, got: parsed, ev: req.logFile }],
        }
      : parsed;
  return { result, exitCode: proc.exitCode, seconds, ...(usage ? { usage } : {}) };
};
