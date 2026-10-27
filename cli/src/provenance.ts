// Which agents and models did the work, for the PR body's Provenance section. Built only
// from the run's recorded history, its routing config, and the IP's Status line, so it
// never states more than brewery knows.
import type { Config, Stage } from "./config.ts";
import { readStatus } from "./ip.ts";
import type { RunState } from "./state.ts";

const SHOWN: [Stage, string][] = [
  ["cut", "Cut"],
  ["review", "Reviews"],
  ["test", "Tests-first writer"],
];

const ran = (state: RunState, stage: string): string[] => [...new Set(state.history.filter((h) => h.stage === stage).map((h) => h.agent))];

const named = (config: Config, agent: string): string => `${agent} (${config.agents[agent]?.model ?? "model unknown"})`;

const approval = (ipText: string | null): string => {
  const status = ipText ? readStatus(ipText) : null;
  const date = status?.match(/^approved\s+(\S+)/i)?.[1];
  if (!status || !date) return "unknown";
  if (/\(pour:/.test(status)) return `plan self-approved by pour ${date}`;
  return `plan approved by the human ${date}`;
};

// What routing recorded as it happened (skips, fallbacks), then each escalation that ran.
// Never inferred from the current config, which can differ from the one a step ran under.
const reroutes = (state: RunState): string[] => {
  const escalated = [...new Set(state.history.filter((h) => h.escalated).map((h) => `${h.stage}: escalated to ${h.agent}`))];
  return [...(state.reroutes ?? []), ...escalated];
};

export const provenance = (state: RunState, config: Config, ipText: string | null): string => {
  const lines = ["### Provenance", ""];
  for (const [stage, label] of SHOWN) {
    const agents = ran(state, stage);
    lines.push(`- ${label}: ${agents.length ? agents.map((a) => named(config, a)).join(", ") : "none recorded"}`);
  }
  lines.push(`- Approval: ${approval(ipText)}`);
  const moved = reroutes(state);
  lines.push(`- Rerouted or fell back: ${moved.length ? moved.join("; ") : "none"}`);
  return lines.join("\n");
};
