// Agent profiles, stage routing, and limits. Layered: built-in defaults ←
// ~/.config/brewery/config.json (or $BREWERY_CONFIG) ← <repo>/.brewery.json ← --agents flag.
// skillsDir defaults to <repo>/.claude/skills when it vendors distill, else $BREWERY_SKILLS_DIR, else the
// plugin skills beside this CLI in a brewery checkout, else ~/.claude/skills.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type AgentType = "claude" | "codex" | "command";

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  envKey: string;
  wireApi?: "responses" | "chat";
}

export interface AgentProfile {
  type: AgentType;
  model?: string;
  args?: string[];
  env?: Record<string, string>;
  // codex only: an OpenAI-compatible provider (litellm in front of local vLLM)
  provider?: ProviderConfig;
  // command only: argv; the prompt arrives on stdin
  command?: string[];
  timeoutMin?: number;
}

export const STAGES = ["distill", "cut", "pick", "roast", "review", "brew", "taste", "compound", "cellar"] as const;
export type Stage = (typeof STAGES)[number];

// Stages whose agents all run and whose verdicts are merged. Every other stage uses
// the first available agent in its list.
export const FAN_OUT: ReadonlySet<Stage> = new Set<Stage>(["cut", "roast", "review"]);

export interface Limits {
  pickAttempts: number;
  parallelTasks: number;
  cutRounds: number;
  reviewRounds: number;
  finishPushes: number;
  finishHours: number;
  ciWaitMin: number;
  stepTimeoutMin: number;
}

// off: no learning step. local: learnings stay in this repo. shared: cellar may also
// generalise them into the brewery skills.
export type LearnMode = "off" | "local" | "shared";

export interface Config {
  agents: Record<string, AgentProfile>;
  stages: Record<Stage, string[]>;
  skillsDir: string;
  worktreeSetup: string[];
  notify: { ntfyUrl?: string };
  learn: LearnMode;
  // The repo handles PHI (Flourish): nothing derived from CI logs is committed.
  phi: boolean;
  limits: Limits;
}

export const DEFAULT_CONFIG: Config = {
  agents: {
    claude: { type: "claude" },
    // Roast checks criteria with named commands; Sonnet is fast enough and cheaper.
    "claude-sonnet": { type: "claude", model: "sonnet" },
    codex: { type: "codex" },
    local: {
      type: "codex",
      model: "deepseek-v4",
      provider: {
        name: "litellm",
        baseUrl: "http://100.76.70.90:4000/v1",
        envKey: "LITELLM_API_KEY",
        wireApi: "responses",
      },
    },
  },
  stages: {
    distill: ["claude"],
    cut: ["claude", "codex"],
    pick: ["claude"],
    roast: ["claude-sonnet"],
    review: ["claude", "codex"],
    brew: ["claude"],
    taste: ["claude"],
    compound: ["claude"],
    cellar: ["claude"],
  },
  skillsDir: join(homedir(), ".claude", "skills"),
  worktreeSetup: [],
  // Shade's ntfy-compatible webhook relays to Slack. Pings carry no content.
  notify: { ntfyUrl: "https://shade-api.nang.io/webhooks/notifications" },
  learn: "local",
  phi: false,
  limits: {
    pickAttempts: 3,
    parallelTasks: 3,
    cutRounds: 2,
    reviewRounds: 1,
    finishPushes: 3,
    finishHours: 4,
    ciWaitMin: 45,
    stepTimeoutMin: 90,
  },
};

type PartialConfig = Partial<Omit<Config, "limits" | "stages">> & {
  limits?: Partial<Limits>;
  stages?: Partial<Record<Stage, string[]>>;
};

const readJson = (path: string): PartialConfig => {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PartialConfig;
  } catch (error) {
    throw new Error(`brewery: cannot parse ${path}: ${(error as Error).message}`);
  }
};

const merge = (base: Config, over: PartialConfig): Config => ({
  agents: { ...base.agents, ...over.agents },
  stages: { ...base.stages, ...over.stages },
  skillsDir: over.skillsDir ?? base.skillsDir,
  worktreeSetup: over.worktreeSetup ?? base.worktreeSetup,
  notify: { ...base.notify, ...over.notify },
  learn: over.learn ?? base.learn,
  phi: over.phi ?? base.phi,
  limits: { ...base.limits, ...over.limits },
});

export const userConfigPath = (): string =>
  process.env.BREWERY_CONFIG ?? join(homedir(), ".config", "brewery", "config.json");

// `repos` in the user config: GitHub owner/name → local checkout, for `brewery cellar`.
export const configuredRepos = (): Record<string, string> =>
  ((readJson(userConfigPath()) as { repos?: Record<string, string> }).repos ?? {});

// `--agents pick=claude,roast=claude+codex+local`
export const parseAgentsFlag = (flag: string): Partial<Record<Stage, string[]>> => {
  const out: Partial<Record<Stage, string[]>> = {};
  for (const pair of flag.split(",").filter(Boolean)) {
    const [stage, list] = pair.split("=");
    if (!STAGES.includes(stage as Stage) || !list) {
      throw new Error(`brewery: bad --agents entry "${pair}" (want stage=agent[+agent])`);
    }
    out[stage as Stage] = list.split("+").filter(Boolean);
  }
  return out;
};

// A repo that vendors the skills (e.g. <repo>/.claude/skills/distill) uses its own copy.
const repoSkillsDir = (repo: string): string | undefined => {
  const dir = join(repo, ".claude", "skills");
  return existsSync(join(dir, "distill", "SKILL.md")) ? dir : undefined;
};

// An image that bakes the skills in (zerg's agent-dev) points here instead of a per-account home.
// Run from a brewery checkout (bin/install links ~/bin/brewery here), the plugin's skills sit beside the CLI.
// A compiled binary has no checkout around it, so it falls through to ~/.claude/skills.
const checkoutSkillsDir = join(import.meta.dir, "..", "..", "plugins", "brewery", "skills");
const installedSkillsDir = (): string =>
  process.env.BREWERY_SKILLS_DIR ||
  (existsSync(join(checkoutSkillsDir, "distill", "SKILL.md")) ? checkoutSkillsDir : DEFAULT_CONFIG.skillsDir);

export const loadConfig = (repo: string, agentsFlag?: string): Config => {
  const defaults = { ...DEFAULT_CONFIG, skillsDir: repoSkillsDir(repo) ?? installedSkillsDir() };
  let config = merge(defaults, readJson(userConfigPath()));
  config = merge(config, readJson(join(repo, ".brewery.json")));
  if (agentsFlag) config = merge(config, { stages: parseAgentsFlag(agentsFlag) });
  if (!isAbsolute(config.skillsDir)) config.skillsDir = join(repo, config.skillsDir);
  for (const stage of STAGES) {
    for (const name of config.stages[stage]) {
      if (!config.agents[name]) throw new Error(`brewery: stage ${stage} names unknown agent "${name}"`);
    }
  }
  return config;
};
