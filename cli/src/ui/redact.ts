// Every event is scrubbed before it leaves the `brewery ui` server. A PHI run keeps only
// structure: an allowlist of structural keys keeps its string values, numbers and booleans
// pass, and every other string is withheld, so a field added later fails closed.
import { scrub } from "../scrub.ts";

export const WITHHELD = "(withheld: phi)";

// Top-level event keys whose string values are structure (stage, task, agent, status,
// timing), not free text. Nested strings are never structure, so they are withheld too.
const STRUCTURE = new Set(["kind", "t", "stage", "task", "agent", "status", "waitingKind", "state"]);

const walk = (value: unknown, phi: boolean, structural = false): unknown => {
  if (typeof value === "string") return phi && !structural ? WITHHELD : scrub(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, phi));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, phi)]));
  }
  return value;
};

export const redactEvent = (event: unknown, phi: boolean): unknown => {
  if (!event || typeof event !== "object" || Array.isArray(event)) return walk(event, phi);
  return Object.fromEntries(Object.entries(event).map(([k, v]) => [k, walk(v, phi, STRUCTURE.has(k))]));
};

// One `events.jsonl` line → the JSON sent to the browser, or undefined for a line that is
// not JSON (never forwarded raw). Scrubbing runs on parsed values, so a rule can never
// break the JSON around it.
export const redactLine = (line: string, phi: boolean): string | undefined => {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  return JSON.stringify(redactEvent(event, phi));
};
