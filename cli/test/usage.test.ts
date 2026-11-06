import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUsageLine } from "../src/agents.ts";
import { loadConfig } from "../src/config.ts";
import { newState, runDir } from "../src/state.ts";
import { runStage } from "../src/step.ts";
import { fakeSetup, quietCtx, tempRepo } from "./helpers.ts";

const CLAUDE_RESULT = {
  type: "result",
  usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 5000 },
  total_cost_usd: 0.042,
};

describe("parseUsageLine", () => {
  test("reads Claude's final result record", () => {
    expect(parseUsageLine("claude", JSON.stringify(CLAUDE_RESULT))).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 5000,
      costUsd: 0.042,
    });
  });

  test("reads a Claude result without cache or cost fields", () => {
    expect(parseUsageLine("claude", JSON.stringify({ type: "result", usage: { input_tokens: 10, output_tokens: 2 } }))).toEqual({
      inputTokens: 10,
      outputTokens: 2,
    });
  });

  test("reads Codex's turn.completed usage, with no cost", () => {
    const line = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 900, cached_input_tokens: 100, output_tokens: 50 } });
    const usage = parseUsageLine("codex", line);
    expect(usage).toEqual({ inputTokens: 900, outputTokens: 50, cacheReadTokens: 100 });
    expect(usage && "costUsd" in usage).toBe(false);
  });

  test("returns null for a malformed line without throwing", () => {
    expect(parseUsageLine("claude", "not json")).toBeNull();
    expect(parseUsageLine("codex", "{\"type\":\"turn.compl")).toBeNull();
    expect(parseUsageLine("claude", "")).toBeNull();
  });

  test("returns null for lines that carry no usage", () => {
    expect(parseUsageLine("claude", JSON.stringify({ type: "assistant", message: { content: [] } }))).toBeNull();
    expect(parseUsageLine("claude", JSON.stringify({ type: "result", result: "done" }))).toBeNull();
    expect(parseUsageLine("codex", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } }))).toBeNull();
  });

  test("returns null for an agent type that reports nothing", () => {
    expect(parseUsageLine("command", JSON.stringify(CLAUDE_RESULT))).toBeNull();
  });

  test("does not read a record of the other agent's shape", () => {
    expect(parseUsageLine("codex", JSON.stringify(CLAUDE_RESULT))).toBeNull();
  });
});

describe("usage recorded by runStage", () => {
  let dir: string;
  let bin: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    dir = tempRepo();
    bin = mkdtempSync(join(tmpdir(), "brewery-usage-bin-"));
    cleanup.push(dir, bin);
  });
  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  // An executable named `claude` or `codex` on PATH that prints the given stdout lines, then writes a PASS result.
  const installAgent = (name: "claude" | "codex", lines: unknown[]): void => {
    const script = join(bin, name);
    writeFileSync(
      script,
      `#!/usr/bin/env bun\n${lines.map((line) => `console.log(${JSON.stringify(JSON.stringify(line))});`).join("\n")}\nawait Bun.write(process.env.BREWERY_RESULT_FILE, JSON.stringify({status:"PASS",action:"done"}));\n`,
    );
    chmodSync(script, 0o755);
  };

  const runWith = async (type: "claude" | "codex" | "command") => {
    fakeSetup(dir, [{ match: "usage step", stdout: [CLAUDE_RESULT] }]);
    const config = loadConfig(dir);
    config.agents.worker = type === "command"
      ? { ...config.agents.alpha }
      : { type, env: { PATH: `${bin}:${process.env.PATH}` } };
    config.stages.pick = ["worker"];
    const state = newState({ slug: "usage", repo: dir, ip: "", base: "master", phase: "build" });
    await runStage(quietCtx(state, config), "pick", "usage step", { task: "T1" });
    const events = (): Record<string, unknown>[] =>
      readFileSync(join(runDir(dir, "usage"), "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    return { state, events: events() };
  };

  test("a Claude step emits one usage event between step.start and step.end and stores it in history", async () => {
    installAgent("claude", [{ type: "system", subtype: "init" }, CLAUDE_RESULT]);
    const { state, events } = await runWith("claude");
    const kinds = events.map((event) => event.kind);
    expect(kinds.filter((kind) => kind === "usage")).toHaveLength(1);
    const start = kinds.indexOf("step.start");
    const usage = kinds.indexOf("usage");
    const end = kinds.indexOf("step.end");
    expect(start).toBeLessThan(usage);
    expect(usage).toBeLessThan(end);
    expect(events[usage]).toMatchObject({ kind: "usage", seq: 1, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 5000, costUsd: 0.042 });
    expect(state.history[0].usage).toEqual({ inputTokens: 1200, outputTokens: 300, cacheReadTokens: 5000, costUsd: 0.042 });
  });

  test("two Codex turns in one step sum into one usage event", async () => {
    installAgent("codex", [
      { type: "turn.completed", usage: { input_tokens: 900, output_tokens: 50 } },
      { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 10 } },
    ]);
    const { state, events } = await runWith("codex");
    const usage = events.filter((event) => event.kind === "usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ seq: 1, inputTokens: 1000, outputTokens: 60 });
    expect(state.history[0].usage).toMatchObject({ inputTokens: 1000, outputTokens: 60 });
  });

  test("a Claude step keeps its final result record instead of summing earlier ones", async () => {
    const final = { type: "result", usage: { input_tokens: 1300, output_tokens: 320, cache_read_input_tokens: 5100 }, total_cost_usd: 0.05 };
    installAgent("claude", [CLAUDE_RESULT, final]);
    const { state, events } = await runWith("claude");
    const usage = events.filter((event) => event.kind === "usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ inputTokens: 1300, outputTokens: 320, cacheReadTokens: 5100, costUsd: 0.05 });
    expect(state.history[0].usage).toEqual({ inputTokens: 1300, outputTokens: 320, cacheReadTokens: 5100, costUsd: 0.05 });
  });

  test("a Claude step with no usage line records nothing", async () => {
    installAgent("claude", [{ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }]);
    const { state, events } = await runWith("claude");
    expect(events.some((event) => event.kind === "usage")).toBe(false);
    expect(state.history[0].usage).toBeUndefined();
  });

  test("a command agent records nothing even when it prints a Claude result line", async () => {
    const { state, events } = await runWith("command");
    expect(events.some((event) => event.kind === "usage")).toBe(false);
    expect(state.history[0].usage).toBeUndefined();
  });
});
