// Launch one agent as its own process. Nothing is shared between calls except the
// repository and the files brewery hands over, so every step is a fresh context.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AgentProfile } from "./config.ts";

export type Status = "PASS" | "FAIL" | "BLOCKED" | "PENDING";

export interface Ask {
  q: string;
  rec: string;
  opts?: string[];
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
  structural?: boolean;
  tally?: { edited: number; moved: number; rebutted: number };
}

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
}

export interface RunOutcome {
  result: StepResult;
  exitCode: number | null;
  seconds: number;
}

const tomlString = (value: string): string => JSON.stringify(value);

export const agentArgv = (profile: AgentProfile, cwd: string): string[] => {
  switch (profile.type) {
    case "claude":
      return [
        "claude",
        "-p",
        "--dangerously-skip-permissions",
        "--output-format",
        "stream-json",
        "--verbose",
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
        "--dangerously-bypass-approvals-and-sandbox",
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

const childEnv = (profile: AgentProfile, req: RunRequest): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // A nested claude must not think it is running inside the parent session.
    if (value !== undefined && key !== "CLAUDECODE" && !key.startsWith("CLAUDE_CODE_")) env[key] = value;
  }
  return {
    ...env,
    ...profile.env,
    BREWERY_PROMPT_FILE: req.promptFile,
    BREWERY_RESULT_FILE: req.resultFile,
  };
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
  const proc = Bun.spawn(agentArgv(req.profile, req.cwd), {
    cwd: req.cwd,
    env: childEnv(req.profile, req),
    stdin: Bun.file(req.promptFile),
    stdout: "pipe",
    stderr: "pipe",
    timeout: req.timeoutMin * 60_000,
  });
  const pump = async (stream: ReadableStream<Uint8Array>, narrate: boolean): Promise<void> => {
    const decoder = new TextDecoder();
    let pending = "";
    const consume = (text: string): void => {
      appendFileSync(req.logFile, text);
      if (!narrate || !req.onNarration) return;
      pending += text;
      let boundary = pending.indexOf("\n");
      while (boundary !== -1) {
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        for (const narration of parseNarrationLine(req.profile.type, line)) req.onNarration(narration);
        boundary = pending.indexOf("\n");
      }
    };
    for await (const chunk of stream) consume(decoder.decode(chunk, { stream: true }));
    consume(decoder.decode());
    if (narrate && req.onNarration && pending) {
      for (const narration of parseNarrationLine(req.profile.type, pending)) req.onNarration(narration);
    }
  };
  await Promise.all([pump(proc.stdout, true), pump(proc.stderr, false), proc.exited]);
  const seconds = Math.round((Date.now() - started) / 1000);
  const parsed = readResult(req.resultFile);
  const result: StepResult =
    typeof parsed === "string"
      ? {
          status: "FAIL",
          action: `Rerun ${req.name}: ${parsed}`,
          fail: [{ need: "a result file", want: req.resultFile, got: parsed, ev: req.logFile }],
        }
      : parsed;
  return { result, exitCode: proc.exitCode, seconds };
};
