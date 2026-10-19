import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentArgv, readOnlyEnv, resultFromStdout, runAgent } from "../src/agents.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { header } from "../src/prompts.ts";
import { newState } from "../src/state.ts";
import type { Ctx } from "../src/step.ts";

const schema = { type: "object", properties: { level: { type: "string" } }, required: ["level"] };
const readOnly = { schema, budgetUsd: 3 };

describe("read-only launch mode", () => {
  test("claude runs bare, cannot edit, and must return the schema", () => {
    const argv = agentArgv(DEFAULT_CONFIG.agents.claude, "/repo", readOnly);
    expect(argv.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(argv).toContain("--bare");
    expect(argv).toContain("--permission-mode");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("Read,Grep,Glob,Bash(git diff:*),Bash(git show:*),Bash(git log:*)");
    expect(argv[argv.indexOf("--disallowedTools") + 1]).toBe("Edit,Write,NotebookEdit");
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("json");
    expect(JSON.parse(argv[argv.indexOf("--json-schema") + 1])).toEqual(schema);
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("3");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("stream-json");
  });

  test("the normal claude launch is unchanged", () => {
    const argv = agentArgv(DEFAULT_CONFIG.agents.claude, "/repo");
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("--bare");
  });

  test("codex runs in its read-only sandbox", () => {
    const argv = agentArgv(DEFAULT_CONFIG.agents.local, "/repo", readOnly);
    expect(argv[argv.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv.at(-1)).toBe("-");
  });

  test("the child environment is an allowlist without GitHub or App credentials", () => {
    const parent = {
      PATH: "/bin",
      HOME: "/home/x",
      GH_TOKEN: "gho_secret",
      GITHUB_TOKEN: "ghs_secret",
      BREWERY_APP_PRIVATE_KEY: "-----BEGIN",
      BREWERY_APPROVE_TOKEN: "t",
      ANTHROPIC_API_KEY: "sk-ant",
      LITELLM_API_KEY: "ll",
      CLAUDECODE: "1",
      RANDOM_SECRET: "x",
    };
    const env = readOnlyEnv(DEFAULT_CONFIG.agents.local, parent);
    expect(env.PATH).toBe("/bin");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant");
    expect(env.LITELLM_API_KEY).toBe("ll");
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "BREWERY_APP_PRIVATE_KEY", "BREWERY_APPROVE_TOKEN", "CLAUDECODE", "RANDOM_SECRET"]) {
      expect(env).not.toHaveProperty(key);
    }
  });

  test("a claude json envelope with structured output becomes a PASS result", () => {
    const stdout = `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", structured_output: { level: "low" } })}\n`;
    expect(resultFromStdout(stdout)).toEqual({ status: "PASS", action: "returned structured output", structured: { level: "low" } });
  });

  test("an error envelope or missing structured output is a FAIL with the reason", () => {
    const errored = resultFromStdout(JSON.stringify({ type: "result", is_error: true, result: "budget exceeded" }));
    expect(errored.status).toBe("FAIL");
    expect(errored.action).toContain("budget exceeded");
    const plain = resultFromStdout("not json at all");
    expect(plain.status).toBe("FAIL");
    expect(plain.action).toContain("no structured output");
  });

  test("runAgent takes the structured result from stdout when no result file is written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brewery-readonly-"));
    const envelope = JSON.stringify({ type: "result", is_error: false, structured_output: { level: "medium" } });
    const outcome = await runAgent({
      name: "approve (fake)",
      profile: { type: "command", command: ["bun", "-e", `console.log(${JSON.stringify(envelope)})`] },
      cwd: dir,
      prompt: "## Step: approve\n",
      promptFile: join(dir, "p.md"),
      resultFile: join(dir, "r.json"),
      logFile: join(dir, "l.log"),
      timeoutMin: 1,
      readOnly,
    });
    expect(outcome.result.status).toBe("PASS");
    expect(outcome.result.structured).toEqual({ level: "medium" });
  });

  test("the prompt header tells a read-only step to answer with the schema instead of a file", () => {
    const ctx: Ctx = {
      state: newState({ slug: "s", repo: "/repo", ip: "", base: "master", phase: "build" }),
      config: DEFAULT_CONFIG,
      log: () => {},
    };
    ctx.state.answers.push({ q: "Q?", a: "ANSWER-SENTINEL", at: "now" });
    ctx.state.notes = ["NOTE-SENTINEL"];
    const text = header(ctx, "/repo/.terreno/x.result.json", { readOnly: true });
    expect(text).not.toContain("ANSWER-SENTINEL");
    expect(text).not.toContain("NOTE-SENTINEL");
    expect(text).not.toContain("status BLOCKED");
    expect(header(ctx, "/repo/.terreno/x.result.json")).toContain("ANSWER-SENTINEL");
    expect(text).toContain("read-only");
    expect(text).toContain("final answer");
    expect(text).not.toContain("write your result as JSON to");
    expect(header(ctx, "/repo/.terreno/x.result.json")).toContain("write your result as JSON to");
  });
});
