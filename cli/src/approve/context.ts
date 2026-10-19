// Everything `brewery approve` knows about one PR head before any model runs: the PR
// itself, the diff, the body split into its sections, the task scope the PR claims,
// the plans it implements (read from the head), and the policy (read from the base).
import type { ApproveConfig, PathRule } from "../config.ts";
import { DEFAULT_CONFIG } from "../config.ts";
import type { ChangedFile, Ci, PrView } from "../vcs.ts";

export interface VerificationRow {
  status: "tested" | "instructions" | "notTested";
  scope: string;
  evidence: string;
}

export interface BodySections {
  text: string;
  why: string;
  whatChanged: string;
  verification: VerificationRow[];
  // The collapsed stage-result YAML, scalar keys and inline lists only.
  stageResult: Record<string, string | string[]> | null;
}

const section = (text: string, heading: string): string => {
  // JS has no \Z; the lazy body ends at the next heading, a details block, or the end of input.
  const match = new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s|^<details>|$(?![\\s\\S]))`, "mi").exec(text);
  return match ? match[1].trim() : "";
};

// "Not tested" contains "tested", so the stricter phrase is matched first.
const ROW_STATUS: [RegExp, VerificationRow["status"]][] = [
  [/⚠️|not tested/i, "notTested"],
  [/✅|tested\b/i, "tested"],
  [/🧭|instructions/i, "instructions"],
];

const parseVerification = (text: string): VerificationRow[] => {
  const rows: VerificationRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.trim().slice(1, -1).split("|").map((c) => c.trim());
    if (cells.length < 3 || /^-+$/.test(cells[0]) || /^status$/i.test(cells[0])) continue;
    const status = ROW_STATUS.find(([re]) => re.test(cells[0]))?.[1];
    if (!status) continue;
    rows.push({ status, scope: cells[1], evidence: cells.slice(2).join(" | ") });
  }
  return rows;
};

const parseStageResult = (text: string): BodySections["stageResult"] => {
  const block = /<summary>\s*Stage result\s*<\/summary>[\s\S]*?```ya?ml\s*([\s\S]*?)```/i.exec(text);
  if (!block) return null;
  const out: Record<string, string | string[]> = {};
  for (const line of block[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const [, key, raw] = kv;
    const value = raw.trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      try {
        const list = JSON.parse(value) as unknown;
        out[key] = Array.isArray(list) ? list.map(String) : [value];
        continue;
      } catch {
        out[key] = value.slice(1, -1).split(",").map((v) => v.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
        continue;
      }
    }
    out[key] = value.replace(/^["']|["']$/g, "");
  }
  return out;
};

export const splitBody = (body: string): BodySections => {
  const text = body ?? "";
  const verification = section(text, "Verification");
  return {
    text,
    why: section(text, "Why"),
    whatChanged: section(text, "What changed"),
    verification: parseVerification(verification),
    stageResult: parseStageResult(text),
  };
};

const expandRange = (from: string, to: string): string[] => {
  const tee = from.startsWith("T") && to.startsWith("T");
  const a = from.replace(/^T/, "").split(".").map(Number);
  const b = to.replace(/^T/, "").split(".").map(Number);
  const prefix = tee ? "T" : "";
  if (a.length === 1 && b.length === 1 && b[0] >= a[0] && b[0] - a[0] <= 50) {
    return Array.from({ length: b[0] - a[0] + 1 }, (_, i) => `${prefix}${a[0] + i}`);
  }
  if (a.length === 2 && b.length === 2 && a[0] === b[0] && b[1] >= a[1] && b[1] - a[1] <= 50) {
    return Array.from({ length: b[1] - a[1] + 1 }, (_, i) => `${a[0]}.${a[1] + i}`);
  }
  return [from, to];
};

// Task ids the PR says it delivers: "Tasks 2.1–2.2", "T1–T3", "(T3, T4)", or the
// stage result's done list ("2.1 Roast PASS").
export const claimedScope = (body: BodySections): string[] => {
  const ids: string[] = [];
  const add = (id: string): void => {
    if (!ids.includes(id)) ids.push(id);
  };
  const text = body.text;
  for (const m of text.matchAll(/\bTasks?\s+(\d+(?:\.\d+)?)\s*[–—-]\s*(\d+(?:\.\d+)?)/g)) expandRange(m[1], m[2]).forEach(add);
  for (const m of text.matchAll(/\bTasks?\s+((?:\d+(?:\.\d+)?)(?:\s*,\s*\d+(?:\.\d+)?)*)(?![\d.]|\s*[–—-])/g)) {
    m[1].split(",").map((s) => s.trim()).filter(Boolean).forEach(add);
  }
  for (const m of text.matchAll(/\b(T\d+)\s*[–—-]\s*(T\d+)\b/g)) expandRange(m[1], m[2]).forEach(add);
  for (const m of text.matchAll(/(?<![\w/.-])(T\d+)\b(?!\s*[–—-]\s*T)/g)) add(m[1]);
  const done = body.stageResult?.done;
  if (Array.isArray(done)) {
    for (const entry of done) {
      const id = /^(T?\d+(?:\.\d+)?)\b/.exec(entry.trim())?.[1];
      if (id) add(id);
    }
  }
  return ids;
};

export interface PlanRef {
  path: string;
  text: string;
  // The PR changes the plan it claims to implement.
  editedInPr: boolean;
}

export const findPlans = async (input: {
  body: BodySections;
  changed: ChangedFile[];
  planDirs: string[];
  readHead: (path: string) => Promise<string | null>;
}): Promise<PlanRef[]> => {
  const candidates: string[] = [];
  const add = (path: string): void => {
    const clean = path.replace(/^\.?\//, "");
    if (!candidates.includes(clean)) candidates.push(clean);
  };
  const dirs = input.planDirs.map((d) => d.replace(/\/+$/, ""));
  for (const dir of dirs) {
    const re = new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[\\w./-]+\\.md`, "g");
    for (const m of input.body.text.matchAll(re)) add(m[0]);
  }
  const slug = input.body.stageResult?.ip;
  if (typeof slug === "string" && slug) for (const dir of dirs) add(`${dir}/${slug}.md`);
  for (const file of input.changed) {
    if (file.path.endsWith(".md") && dirs.some((dir) => file.path.startsWith(`${dir}/`))) add(file.path);
  }
  // A plan's tasks file lives beside it under docs/tasks/<slug>.md when the repo keeps them apart.
  for (const path of [...candidates]) {
    const base = path.split("/").pop()?.replace(/\.md$/, "");
    if (base && !path.startsWith("docs/tasks/") && dirs.includes("docs/tasks")) add(`docs/tasks/${base}.md`);
  }
  const changedPaths = new Set(input.changed.map((f) => f.path));
  const plans: PlanRef[] = [];
  for (const path of candidates) {
    const text = await input.readHead(path);
    if (text === null) continue;
    plans.push({ path, text, editedInPr: changedPaths.has(path) });
  }
  return plans;
};

export interface EvidenceInventory {
  media: string[];
  testFiles: string[];
}

const MEDIA_RE = /(?:!\[[^\]]*\]\(([^)\s]+)\)|<img[^>]+src="([^"]+)"|<video[^>]+src="([^"]+)"|(https?:\/\/\S+\.(?:png|jpe?g|gif|webp|mp4|mov|webm)))/gi;

export const evidenceInventory = (body: string, files: ChangedFile[], rules: PathRule[]): EvidenceInventory => {
  const media: string[] = [];
  for (const m of body.matchAll(MEDIA_RE)) {
    const url = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (url && !media.includes(url)) media.push(url);
  }
  const testRules = rules.filter((r) => r.category === "tests");
  const testFiles = files.map((f) => f.path).filter((p) => testRules.some((r) => r.match.some((g) => new Bun.Glob(g).match(p))));
  return { media, testFiles };
};

// The approve block of a .brewery.json read from the base branch, over the defaults. A
// missing or unparsable file means the defaults; the PR cannot relax policy from its head.
export const approveFromJson = (text: string | null): ApproveConfig => {
  if (text === null) return { ...DEFAULT_CONFIG.approve };
  try {
    const parsed = JSON.parse(text) as { approve?: Partial<ApproveConfig> };
    return { ...DEFAULT_CONFIG.approve, ...(parsed.approve ?? {}) };
  } catch {
    return { ...DEFAULT_CONFIG.approve };
  }
};

export interface Policy {
  approve: ApproveConfig;
  // The repo's rubric markdown, or null to use the shipped default.
  rubric: string | null;
  // "<base>@<sha>", for the review body.
  source: string;
}

export interface ApproveContext {
  pr: PrView;
  files: ChangedFile[];
  diff: string;
  body: BodySections;
  scope: string[];
  plans: PlanRef[];
  policy: Policy;
  evidence: EvidenceInventory;
}

export const gatherContext = async (input: {
  ci: Pick<Ci, "prView" | "prFiles" | "prDiff">;
  repo: string;
  pr: number;
  planDirs?: string[];
  readBase: (path: string) => Promise<string | null>;
  readHead: (path: string) => Promise<string | null>;
  baseSha: () => Promise<string>;
}): Promise<ApproveContext> => {
  const pr = await input.ci.prView(input.repo, input.pr);
  const approve = approveFromJson(await input.readBase(".brewery.json"));
  const rubric = await input.readBase(approve.rubric);
  const [files, diff, sha] = await Promise.all([input.ci.prFiles(input.repo, input.pr), input.ci.prDiff(input.repo, input.pr), input.baseSha()]);
  const body = splitBody(pr.body);
  const planDirs = input.planDirs ?? approve.planDirs;
  const plans = await findPlans({ body, changed: files, planDirs, readHead: input.readHead });
  return {
    pr,
    files,
    diff,
    body,
    scope: claimedScope(body),
    plans,
    policy: { approve, rubric, source: `${pr.base}@${sha}` },
    evidence: evidenceInventory(pr.body, files, approve.pathRules),
  };
};
