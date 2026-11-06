import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readResult, type StepResult } from "../src/agents.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { header } from "../src/prompts.ts";
import { newState } from "../src/state.ts";
import type { Ctx } from "../src/step.ts";

const dir = mkdtempSync(join(tmpdir(), "handoff-contract-"));
let n = 0;
const write = (body: Record<string, unknown>): string => {
  const file = join(dir, `r${n++}.result.json`);
  writeFileSync(file, JSON.stringify({ status: "PASS", action: "next", summary: "did it", ...body }));
  return file;
};
const read = (body: Record<string, unknown>): StepResult => {
  const result = readResult(write(body));
  if (typeof result === "string") throw new Error(`readResult failed: ${result}`);
  return result;
};
type Handoff = { did: string; learned: string[]; traps: string[]; files: string[] };
const handoffOf = (r: StepResult): Handoff | undefined => (r as StepResult & { handoff?: Handoff }).handoff;

const valid: Handoff = {
  did: "Added the parser",
  learned: ["config lives in cli/src/config.ts"],
  traps: ["tests share a temp dir"],
  files: ["cli/src/agents.ts"],
};

describe("readResult handoff", () => {
  test("a valid handoff is returned unchanged", () => {
    expect(handoffOf(read({ handoff: valid }))).toEqual(valid);
  });

  test("no handoff leaves the result unchanged", () => {
    const result = read({});
    expect(result).toEqual({ status: "PASS", action: "next", summary: "did it" });
    expect("handoff" in result).toBe(false);
  });

  test("learned with 12 items keeps 8", () => {
    const learned = Array.from({ length: 12 }, (_, i) => `item ${i}`);
    expect(handoffOf(read({ handoff: { ...valid, learned } }))?.learned).toEqual(learned.slice(0, 8));
  });

  test("traps and files are capped at 8 items too", () => {
    const many = Array.from({ length: 12 }, (_, i) => `x${i}`);
    const h = handoffOf(read({ handoff: { ...valid, traps: many, files: many } }));
    expect(h?.traps).toHaveLength(8);
    expect(h?.files).toHaveLength(8);
  });

  test("a 1000-char did is cut to 400 chars ending in an ellipsis", () => {
    const did = handoffOf(read({ handoff: { ...valid, did: "a".repeat(1000) } }))?.did;
    expect(did).toBe(`${"a".repeat(399)}…`);
    expect(did?.length).toBe(400);
  });

  test("a did of exactly 400 chars is untouched", () => {
    expect(handoffOf(read({ handoff: { ...valid, did: "b".repeat(400) } }))?.did).toBe("b".repeat(400));
  });

  test("a list item over 200 chars is cut to 200 ending in an ellipsis", () => {
    const h = handoffOf(read({ handoff: { ...valid, learned: ["c".repeat(500)] } }));
    expect(h?.learned).toEqual([`${"c".repeat(199)}…`]);
  });

  test("a handoff that is a string is dropped, the status stays as written", () => {
    const result = read({ status: "FAIL", handoff: "text" });
    expect(result.status).toBe("FAIL");
    expect(handoffOf(result)).toBeUndefined();
    expect("handoff" in result).toBe(false);
  });

  test("a handoff missing did is dropped, the status stays as written", () => {
    const result = read({ status: "BLOCKED", handoff: { learned: [], traps: [], files: [] } });
    expect(result.status).toBe("BLOCKED");
    expect("handoff" in result).toBe(false);
  });

  test("a handoff whose lists are not arrays of strings is dropped without failing the step", () => {
    const result = read({ handoff: { did: "x", learned: "nope", traps: [1, 2], files: null } });
    expect(result.status).toBe("PASS");
    expect("handoff" in result).toBe(false);
  });

  test("a token in traps is scrubbed", () => {
    const h = handoffOf(read({ handoff: { ...valid, traps: ["token sk-abcdefghijklmnopqrstuv in .env"] } }));
    expect(h?.traps).toEqual(["token [token] in .env"]);
  });

  test("a token in did and learned is scrubbed", () => {
    const h = handoffOf(
      read({ handoff: { ...valid, did: "used sk-abcdefghijklmnopqrstuv", learned: ["key sk-abcdefghijklmnopqrstuv"] } }),
    );
    expect(h?.did).toBe("used [token]");
    expect(h?.learned).toEqual(["key [token]"]);
  });

  test("a token in files is scrubbed but paths survive", () => {
    const files = ["docs/plans/2026-11-05-x.md", "cli/src/ids/12345678.ts"];
    expect(handoffOf(read({ handoff: { ...valid, files } }))?.files).toEqual(files);
    const withToken = handoffOf(read({ handoff: { ...valid, files: ["sk-abcdefghijklmnopqrstuv.txt"] } }));
    expect(withToken?.files).toEqual(["[token].txt"]);
  });
});

describe("header handoff instruction", () => {
  const ctx: Ctx = {
    state: newState({ slug: "s", repo: "/repo", ip: "", base: "master", phase: "build" }),
    config: DEFAULT_CONFIG,
    log: () => {},
  };
  const file = "/repo/.terreno/x.result.json";

  test("a writing step with handoff: true is told the handoff shape", () => {
    const text = header(ctx, file, { readOnly: false, handoff: true } as never);
    expect(text).toContain("handoff");
    for (const key of ["did", "learned", "traps", "files"]) expect(text).toContain(key);
    expect(text.toLowerCase()).toContain("phi");
    expect(text.toLowerCase()).toContain("secret");
  });

  test("handoff: false does not mention a handoff", () => {
    expect(header(ctx, file, { readOnly: false, handoff: false } as never).toLowerCase()).not.toContain("handoff");
  });

  test("a read-only step does not mention a handoff even when asked", () => {
    expect(header(ctx, file, { readOnly: true, handoff: true } as never).toLowerCase()).not.toContain("handoff");
  });

  test("the default header does not mention a handoff", () => {
    expect(header(ctx, file).toLowerCase()).not.toContain("handoff");
  });
});
