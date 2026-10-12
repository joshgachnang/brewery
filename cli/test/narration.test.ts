import { describe, expect, test } from "bun:test";
import { agentArgv, parseNarrationLine, runAgent } from "../src/agents.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

describe("streamed agent narration", () => {
  test("launches Claude and Codex with structured streaming output", () => {
    expect(agentArgv(DEFAULT_CONFIG.agents.claude, "/repo")).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--verbose"]));
    expect(agentArgv(DEFAULT_CONFIG.agents.codex, "/repo")).toContain("--json");
  });

  test("turns Claude assistant text and tool calls into short lines", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [
      { type: "text", text: "Reading the queue.\nChecking routing." },
      { type: "tool_use", name: "Read", input: { file_path: "/repo/groupQueue.ts" } },
      { type: "tool_use", name: "Bash", input: { command: "bun test" } },
    ] } });
    expect(parseNarrationLine("claude", line)).toEqual(["Reading the queue. Checking routing.", "Read groupQueue.ts", "Bash: bun test"]);
  });

  test("turns Codex message and started tool items into narration", () => {
    expect(parseNarrationLine("codex", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Tests pass." } }))).toEqual(["Tests pass."]);
    expect(parseNarrationLine("codex", JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "bun test" } }))).toEqual(["Bash: bun test"]);
    expect(parseNarrationLine("codex", JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "bun test", aggregated_output: "secret" } }))).toEqual([]);
    expect(parseNarrationLine("codex", JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call", server: "files", tool: "read_file" } }))).toEqual(["MCP files.read_file"]);
    expect(parseNarrationLine("codex", JSON.stringify({ type: "item.started", item: { type: "web_search", query: "Bun streams" } }))).toEqual(["Search: Bun streams"]);
    expect(parseNarrationLine("codex", JSON.stringify({ type: "item.started", item: { type: "file_change", changes: [{ path: "a.ts", kind: "update" }] } }))).toEqual(["Edit files"]);
  });

  test("ignores invalid and non-narrative output and truncates at 300 characters", () => {
    expect(parseNarrationLine("claude", "not json")).toEqual([]);
    expect(parseNarrationLine("claude", JSON.stringify({ type: "result", result: "duplicate final answer" }))).toEqual([]);
    expect(parseNarrationLine("command", JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }))).toEqual([]);
    const text = "x".repeat(400);
    expect(parseNarrationLine("codex", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }))).toEqual(["x".repeat(300)]);
  });

  for (const type of ["claude", "codex"] as const) {
    test(`${type} narrates before exit and retains structured output in the raw log`, async () => {
      const dir = mkdtempSync(join(import.meta.dir, `.brewery-${type}-`));
      const executable = join(dir, type);
      const output = type === "claude"
        ? { type: "assistant", message: { content: [{ type: "text", text: "Working now." }] } }
        : { type: "item.completed", item: { type: "agent_message", text: "Working now." } };
      const encoded = JSON.stringify(output);
      const half = Math.floor(encoded.length / 2);
      writeFileSync(executable, `#!/usr/bin/env bun\nprocess.stdout.write(${JSON.stringify(encoded.slice(0, half))});\nawait Bun.sleep(30);\nprocess.stdout.write(${JSON.stringify(encoded.slice(half) + "\n")});\nconsole.error("stderr is raw only");\nconsole.log("not json");\nawait Bun.sleep(200);\nawait Bun.write(process.env.BREWERY_RESULT_FILE, JSON.stringify({status:"PASS",action:"done"}));\n`);
      chmodSync(executable, 0o755);
      try {
        let announced!: () => void;
        const narrated = new Promise<void>((resolve) => { announced = resolve; });
        const lines: string[] = [];
        let finished = false;
        const pending = runAgent({
          name: type,
          profile: { type, env: { PATH: `${dir}:${process.env.PATH}` } },
          cwd: dir,
          prompt: "test prompt",
          promptFile: join(dir, "prompt.md"),
          resultFile: join(dir, "result.json"),
          logFile: join(dir, "raw.log"),
          timeoutMin: 1,
          onNarration: (text) => { lines.push(text); announced(); },
        }).finally(() => { finished = true; });
        await narrated;
        expect(finished).toBe(false);
        expect(lines).toEqual(["Working now."]);
        expect((await pending).result.status).toBe("PASS");
        expect(readFileSync(join(dir, "raw.log"), "utf8")).toContain(JSON.stringify(output));
        expect(readFileSync(join(dir, "raw.log"), "utf8")).toContain("stderr is raw only");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("command profile preserves output without narration", async () => {
    const dir = mkdtempSync(join(import.meta.dir, ".brewery-command-"));
    const executable = join(dir, "script");
    writeFileSync(executable, `#!/usr/bin/env bun\nconsole.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"ignore me"}]}}));\nawait Bun.write(process.env.BREWERY_RESULT_FILE, JSON.stringify({status:"PASS",action:"done"}));\n`);
    chmodSync(executable, 0o755);
    try {
      const narrated: string[] = [];
      const outcome = await runAgent({
        name: "command",
        profile: { type: "command", command: [executable] },
        cwd: dir,
        prompt: "test",
        promptFile: join(dir, "prompt.md"),
        resultFile: join(dir, "result.json"),
        logFile: join(dir, "raw.log"),
        timeoutMin: 1,
        onNarration: (text) => narrated.push(text),
      });
      expect(outcome.result.status).toBe("PASS");
      expect(narrated).toEqual([]);
      expect(readFileSync(join(dir, "raw.log"), "utf8")).toContain("ignore me");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stage events persist start, narration, and end with the same sequence", async () => {
    const dir = mkdtempSync(join(import.meta.dir, ".brewery-stage-"));
    const executable = join(dir, "claude");
    writeFileSync(executable, `#!/usr/bin/env bun\nif (process.argv.includes("--version")) { console.log("fake 1.0"); process.exit(0); }\nconsole.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"Stage is working"}]}}));\nawait Bun.write(process.env.BREWERY_RESULT_FILE, JSON.stringify({status:"PASS",action:"done"}));\n`);
    chmodSync(executable, 0o755);
    try {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "narration-stage.ts"), dir], {
        cwd: dir,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, BREWERY_INDEX: join(dir, "index.json") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      const events = readFileSync(join(dir, ".terreno", "brewery", "stage", "events.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
      expect(events.map(({ kind }: { kind: string }) => kind)).toEqual(["step.start", "narration", "step.end"]);
      expect(events.map(({ seq }: { seq: number }) => seq)).toEqual([1, 1, 1]);
      expect(events[1].text).toBe("Stage is working");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
