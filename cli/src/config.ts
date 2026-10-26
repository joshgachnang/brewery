// Agent profiles, stage routing, and limits. Layered: built-in defaults ←
// ~/.config/brewery/config.json (or $BREWERY_CONFIG) ← <repo>/.brewery.json ← --agents flag.
// skillsDir defaults to <repo>/.claude/skills when it vendors distill, else $BREWERY_SKILLS_DIR, else the
// plugin skills beside this CLI in a brewery checkout, else ~/.claude/skills.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type AgentType = "claude" | "codex" | "cursor" | "command";

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
  // cursor only: the CLI binary (default `agent`; older installs call it `cursor-agent`)
  bin?: string;
  timeoutMin?: number;
}

export const STAGES = ["distill", "cut", "test", "pick", "roast", "review", "brew", "taste", "compound", "cellar", "approve", "calibrate"] as const;
export type Stage = (typeof STAGES)[number];

// Stages whose agents all run and whose verdicts are merged. Every other stage uses
// the first available agent in its list.
export const FAN_OUT: ReadonlySet<Stage> = new Set<Stage>(["cut", "roast", "review", "approve"]);

export type RiskLevel = "low" | "medium" | "high";

// One `brewery approve` path rule. A file's categories come from every rule it matches.
// `floor` raises the PR's minimum level, `ceiling` caps it (only when every changed file
// matches a ceiling rule), and `never` blocks approval outright.
export interface PathRule {
  match: string[];
  category: string;
  floor?: RiskLevel;
  ceiling?: RiskLevel;
  never?: boolean;
}

export interface ApproveConfig {
  // Levels the App may approve. Empty means comment-only (dry-run rollout).
  approveLevels: RiskLevel[];
  // Repo-relative rubric markdown, read from the base branch. Absent → the shipped default.
  rubric: string;
  // Where implementation plans live, searched in order.
  planDirs: string[];
  skipAuthors: string[];
  skipLabels: string[];
  maxLines: number;
  maxFiles: number;
  // Dollar budget per read-only agent step.
  budgetUsd: number;
  // A repo's list replaces this one wholesale.
  pathRules: PathRule[];
  // Check names that belong to the approver itself (its check run and the CI job it runs
  // in). They never count as pending or failing, so a job can judge the head it runs on.
  selfChecks: string[];
}

export const DEFAULT_PATH_RULES: PathRule[] = [
  { match: ["docs/**", "**/*.md"], category: "docs", ceiling: "low" },
  { match: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "e2e/**", "**/__snapshots__/**", "**/fixtures/**"], category: "tests", ceiling: "low" },
  { match: ["**/auth/**", "**/permissions/**", "**/session*"], category: "auth", floor: "high" },
  { match: ["**/migrations/**", "**/models/**"], category: "migrations", floor: "high" },
  { match: ["terraform/**", "infra/**", "Dockerfile*", "**/*.env*"], category: "infra", floor: "high" },
  { match: [".circleci/**", ".github/workflows/**", ".github/scripts/**"], category: "ci", never: true },
  { match: [".brewery.json", "docs/approval-rubric.md"], category: "policy", never: true },
  { match: ["**/bun.lock", "**/package.json", "**/yarn.lock"], category: "deps", floor: "medium" },
];

export interface Limits {
  pickAttempts: number;
  // Write each task's tests in their own step, confirmed red, before Pick implements it.
  testFirst: boolean;
  // A test or pick step that has already run this many times for a task moves to `escalate`.
  escalateAfter: number;
  // `brewery pour` approves its own plan only when it has at most this many tasks.
  pourMaxTasks: number;
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
  // Stronger agents for a step that keeps failing. A repo's map replaces this one wholesale.
  escalate: Partial<Record<Stage, string[]>>;
  skillsDir: string;
  worktreeSetup: string[];
  notify: { ntfyUrl?: string };
  learn: LearnMode;
  // The repo handles PHI (Flourish): nothing derived from CI logs is committed.
  phi: boolean;
  limits: Limits;
  approve: ApproveConfig;
}

export const DEFAULT_CONFIG: Config = {
  agents: {
    claude: { type: "claude" },
    // Roast checks criteria with named commands; Sonnet is fast enough and cheaper.
    "claude-sonnet": { type: "claude", model: "sonnet" },
    "claude-opus": { type: "claude", model: "opus" },
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
    // Tests come from the task's brief, not the implementation, so a cheaper model writes them.
    test: ["claude-sonnet"],
    pick: ["claude"],
    roast: ["claude-sonnet"],
    review: ["claude", "codex"],
    brew: ["claude"],
    taste: ["claude"],
    compound: ["claude"],
    cellar: ["claude"],
    approve: ["claude"],
    calibrate: ["claude"],
  },
  escalate: { test: ["claude-opus"], pick: ["claude-opus"] },
  skillsDir: join(homedir(), ".claude", "skills"),
  worktreeSetup: [],
  // Shade's ntfy-compatible webhook relays to Slack. Pings carry no content.
  notify: { ntfyUrl: "https://shade-api.nang.io/webhooks/notifications" },
  learn: "local",
  phi: false,
  limits: {
    pickAttempts: 3,
    testFirst: true,
    escalateAfter: 2,
    pourMaxTasks: 6,
    parallelTasks: 3,
    cutRounds: 2,
    reviewRounds: 1,
    finishPushes: 3,
    finishHours: 4,
    ciWaitMin: 45,
    stepTimeoutMin: 90,
  },
  approve: {
    approveLevels: ["low"],
    rubric: "docs/approval-rubric.md",
    planDirs: ["docs/implementationPlans", "docs/plans", "docs/tasks"],
    skipAuthors: ["dependabot[bot]"],
    skipLabels: ["do-not-merge", "hold"],
    maxLines: 800,
    maxFiles: 40,
    budgetUsd: 5,
    pathRules: DEFAULT_PATH_RULES,
    selfChecks: ["terreno/approve", "ci/circleci: approve", "approve"],
  },
};

type PartialConfig = Partial<Omit<Config, "limits" | "stages" | "approve">> & {
  limits?: Partial<Limits>;
  stages?: Partial<Record<Stage, string[]>>;
  approve?: Partial<ApproveConfig>;
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
  escalate: over.escalate ?? base.escalate,
  skillsDir: over.skillsDir ?? base.skillsDir,
  worktreeSetup: over.worktreeSetup ?? base.worktreeSetup,
  notify: { ...base.notify, ...over.notify },
  learn: over.learn ?? base.learn,
  phi: over.phi ?? base.phi,
  limits: { ...base.limits, ...over.limits },
  approve: { ...base.approve, ...over.approve },
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
    for (const name of config.escalate[stage] ?? []) {
      if (!config.agents[name]) throw new Error(`brewery: escalation for ${stage} names unknown agent "${name}"`);
    }
  }
  return config;
};
