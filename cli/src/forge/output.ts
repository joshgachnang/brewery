// How `forge` prints: the full object, a gh-style `--json a,b` field selection, or either of
// those through `-q/--jq` (run by the `jq` binary, with -r like gh's --jq).
import { ForgeError } from "./types.ts";

export const runJq = async (json: string, expr: string): Promise<string> => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["jq", "-r", expr], { stdin: new Blob([json]), stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    throw new ForgeError(`forge: -q needs jq on PATH (${error instanceof Error ? error.message : String(error)})`);
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new ForgeError(`forge: jq ${expr}: ${err.trim()}`);
  return out;
};

export const emit = async (out: string, jq?: string): Promise<void> => {
  if (!jq) {
    process.stdout.write(out.endsWith("\n") || !out ? out : `${out}\n`);
    return;
  }
  process.stdout.write(await runJq(out, jq));
};

// Keep only the named top-level fields, in the order asked. An unknown field is an error that
// lists the ones that exist, like gh.
export const pick = (value: unknown, fields: string[] | null): unknown => {
  if (!fields) return value;
  const one = (item: unknown): Record<string, unknown> => {
    const obj = item as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      if (!(f in obj)) throw new ForgeError(`forge: unknown JSON field "${f}"; available: ${Object.keys(obj).join(", ")}`);
      out[f] = obj[f];
    }
    return out;
  };
  return Array.isArray(value) ? value.map(one) : one(value);
};

export const printJson = async (value: unknown, fields: string[] | null, jq?: string): Promise<void> => {
  await emit(JSON.stringify(pick(value, fields), null, jq ? 0 : 2), jq);
};
