import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASH_MAX_TIMEOUT_MS, childEnv, runAgent, turnSignal } from "../src/agents.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const files = { promptFile: "/runs/p.md", resultFile: "/runs/r.json" };
const RESULT = JSON.stringify({ type: "result", subtype: "success" });
const ASSISTANT = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Back at it." }] } });

describe("the Bash cap brewery gives a Claude step", () => {
  test("a writing Claude step may run one command for 45 minutes", () => {
    expect(BASH_MAX_TIMEOUT_MS).toBe(2_700_000);
    expect(childEnv({ type: "claude" }, files).BASH_MAX_TIMEOUT_MS).toBe("2700000");
  });

  test("stays under the default step timeout, so a hung command still ends", () => {
    expect(BASH_MAX_TIMEOUT_MS).toBeLessThan(DEFAULT_CONFIG.limits.stepTimeoutMin * 60_000);
  });

  test("the caller's environment and the agent profile both override it", () => {
    const before = process.env.BASH_MAX_TIMEOUT_MS;
    process.env.BASH_MAX_TIMEOUT_MS = "600000";
    try {
      expect(childEnv({ type: "claude" }, files).BASH_MAX_TIMEOUT_MS).toBe("600000");
      expect(childEnv({ type: "claude", env: { BASH_MAX_TIMEOUT_MS: "900000" } }, files).BASH_MAX_TIMEOUT_MS).toBe("900000");
    } finally {
      if (before === undefined) delete process.env.BASH_MAX_TIMEOUT_MS;
      else process.env.BASH_MAX_TIMEOUT_MS = before;
    }
  });

  test("other agents and read-only steps are left alone", () => {
    const before = process.env.BASH_MAX_TIMEOUT_MS;
    delete process.env.BASH_MAX_TIMEOUT_MS;
    try {
      expect(childEnv({ type: "codex" }, files).BASH_MAX_TIMEOUT_MS).toBeUndefined();
      expect(childEnv({ type: "command", command: ["true"] }, files).BASH_MAX_TIMEOUT_MS).toBeUndefined();
      expect(childEnv({ type: "claude" }, { ...files, readOnly: { schema: {} } }).BASH_MAX_TIMEOUT_MS).toBeUndefined();
    } finally {
      if (before !== undefined) process.env.BASH_MAX_TIMEOUT_MS = before;
    }
  });
});

describe("turn signals in Claude's stream", () => {
  test("a result record ends a turn and an assistant record starts one", () => {
    expect(turnSignal("claude", RESULT)).toBe("ended");
    expect(turnSignal("claude", ASSISTANT)).toBe("resumed");
  });

  test("other records, other agents, and non-JSON lines are no signal", () => {
    expect(turnSignal("claude", JSON.stringify({ type: "system", subtype: "task_progress" }))).toBeNull();
    expect(turnSignal("claude", "not json")).toBeNull();
    expect(turnSignal("codex", RESULT)).toBeNull();
    expect(turnSignal("command", RESULT)).toBeNull();
  });
});

describe("an agent that ends its turn and stays alive", () => {
  // A fake `claude` on PATH: runs `script`, then idles for a minute like a process that
  // is waiting on a background command or a scheduled wakeup.
  const runFake = async (script: string, settleMs: number): Promise<{ status: string; seconds: number; log: string }> => {
    const dir = mkdtempSync(join(import.meta.dir, ".brewery-settle-"));
    const executable = join(dir, "claude");
    writeFileSync(executable, `#!/usr/bin/env bun\nconst write = (status) => Bun.write(process.env.BREWERY_RESULT_FILE, JSON.stringify({status, action: "done"}));\n${script}\nawait Bun.sleep(60_000);\n`);
    chmodSync(executable, 0o755);
    const started = Date.now();
    try {
      const outcome = await runAgent({
        name: "pick T1 (claude)",
        profile: { type: "claude", env: { PATH: `${dir}:${process.env.PATH}` } },
        cwd: dir,
        prompt: "test prompt",
        promptFile: join(dir, "prompt.md"),
        resultFile: join(dir, "result.json"),
        logFile: join(dir, "raw.log"),
        timeoutMin: 1,
        settleMs,
      });
      return { status: outcome.result.status, seconds: (Date.now() - started) / 1000, log: readFileSync(join(dir, "raw.log"), "utf8") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("is stopped soon after its result is written, and the result stands", async () => {
    const { status, seconds, log } = await runFake(`await write("PASS");\nconsole.log(${JSON.stringify(RESULT)});`, 300);
    expect(status).toBe("PASS");
    expect(seconds).toBeLessThan(20);
    expect(log).toContain("# brewery: the agent wrote its result and ended its turn; stopped it after 0s idle");
  }, 30_000);

  test("is left running while a later turn is still working, then stopped when that turn ends", async () => {
    const script = [
      `await write("PENDING");`,
      `console.log(${JSON.stringify(RESULT)});`,
      `await Bun.sleep(100);`,
      `console.log(${JSON.stringify(ASSISTANT)});`,
      // Longer than the settle time: only the resumed turn keeps the process alive.
      `await Bun.sleep(1500);`,
      `await write("PASS");`,
      `console.log(${JSON.stringify(RESULT)});`,
    ].join("\n");
    const { status, seconds } = await runFake(script, 500);
    expect(status).toBe("PASS");
    expect(seconds).toBeGreaterThan(1.5);
    expect(seconds).toBeLessThan(20);
  }, 30_000);

  test("is not stopped for ending a turn before any result is written", async () => {
    const script = [
      `console.log(${JSON.stringify(RESULT)});`,
      `await Bun.sleep(1200);`,
      `await write("PASS");`,
      `console.log(${JSON.stringify(RESULT)});`,
    ].join("\n");
    const { status, seconds } = await runFake(script, 300);
    expect(status).toBe("PASS");
    expect(seconds).toBeGreaterThan(1.2);
  }, 30_000);
});
