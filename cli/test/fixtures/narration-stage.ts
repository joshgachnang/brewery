// Run a real stage in a child process so its fake Claude binary has an isolated PATH.
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { newState, saveState } from "../../src/state.ts";
import { runStage } from "../../src/step.ts";

const repo = process.argv[2];
const state = newState({ slug: "stage", repo, ip: "plan.md", base: "master", phase: "distill" });
saveState(state);
const config = {
  ...DEFAULT_CONFIG,
  agents: { ...DEFAULT_CONFIG.agents, stageFake: { type: "claude" as const } },
  stages: { ...DEFAULT_CONFIG.stages, distill: ["stageFake"] },
};
await runStage({ state, config, log: () => {} }, "distill", "test step");
