// brewery approve <pr>: one head, one verdict, one review. Policy from the base branch,
// context from the head, a clean plan judge, then the rubric, then code decides and posts.
import { gatherContext, type ApproveContext } from "../approve/context.ts";
import { mergeJudges, runJudge } from "../approve/judge.ts";
import { classify } from "../approve/policy.ts";
import { checkRun, markerSha, renderBody, renderSkip } from "../approve/render.ts";
import { mergeVerdict, runRubric, type Verdict } from "../approve/review.ts";
import { appendEvent } from "../events.ts";
import { type Ctx } from "../step.ts";
import { git, type Ci, type PrView } from "../vcs.ts";

// Where the verdict goes. GitHub in production (T7); a recorder in tests.
export interface Poster {
  // The App's login as it appears on reviews (both "<slug>" and "<slug>[bot]" are matched).
  appLogin: string;
  post: (input: { context: ApproveContext; verdict: Verdict; body: string }) => Promise<void>;
  skip: (input: { context: ApproveContext; reason: string; body: string }) => Promise<void>;
}

export interface ApproveDeps {
  ci: Pick<Ci, "prView" | "prFiles" | "prDiff">;
  readBase: (path: string) => Promise<string | null>;
  readHead: (path: string) => Promise<string | null>;
  baseSha: () => Promise<string>;
  poster?: Poster;
}

export interface ApproveOutcome {
  headSha: string;
  verdict: Verdict | null;
  skipped: string | null;
  body: string;
  posted: boolean;
}

const sameLogin = (author: string, appLogin: string): boolean => {
  const bare = appLogin.replace(/\[bot\]$/, "");
  return author === bare || author === `${bare}[bot]` || author === `app/${bare}`;
};

// Reasons not to spend a model on this head. The first that applies wins.
export const skipReason = (context: ApproveContext, appLogin: string | undefined): string | null => {
  const { pr, policy } = context;
  if (pr.isDraft) return "draft pull request";
  const label = pr.labels.find((l) => policy.approve.skipLabels.includes(l));
  if (label) return `label "${label}"`;
  if (policy.approve.skipAuthors.includes(pr.author)) return `author ${pr.author} is skipped by policy`;
  if (appLogin && sameLogin(pr.author, appLogin)) return "the approver cannot review its own pull request";
  const latest = new Map<string, string>();
  for (const r of pr.reviews) if (!r.isBot && r.state !== "COMMENTED" && r.state !== "PENDING") latest.set(r.author, r.state);
  const human = [...latest.entries()].find(([, state]) => state === "CHANGES_REQUESTED")?.[0];
  if (human) return `${human} requested changes`;
  if (appLogin) {
    const mine = pr.reviews.find((r) => sameLogin(r.author, appLogin) && r.state === "APPROVED" && markerSha(r.body) === pr.headSha);
    if (mine) return `already approved at ${pr.headSha.slice(0, 7)}`;
  }
  return null;
};

export const approve = async (ctx: Ctx, deps: ApproveDeps, pr: number, opts: { dryRun: boolean; view?: PrView }): Promise<ApproveOutcome> => {
  const { log } = ctx;
  const context = await gatherContext({ ci: deps.ci, repo: ctx.state.repo, pr, view: opts.view, readBase: deps.readBase, readHead: deps.readHead, baseSha: deps.baseSha });
  const head = context.pr.headSha;
  log(`approve #${pr} at ${head.slice(0, 7)} (${context.files.length} files, policy ${context.policy.source})`);
  const skipped = skipReason(context, deps.poster?.appLogin);
  if (skipped) {
    const body = renderSkip(head, skipped);
    log(`  skip: ${skipped}`);
    let posted = false;
    if (!opts.dryRun) {
      if (!deps.poster) throw new Error("brewery approve: no poster configured; use --dry-run or set the App credentials");
      await deps.poster.skip({ context, reason: skipped, body });
      posted = true;
    }
    return { headSha: head, verdict: null, skipped, body, posted };
  }
  const approveConfig = context.policy.approve;
  const classification = classify(context.files.map((f) => f.path), approveConfig.pathRules);
  log(`  band: floor ${classification.floor ?? "none"}, ceiling ${classification.ceiling ?? "none"}${classification.never.length ? `, never ${classification.never.join(", ")}` : ""}`);
  const judgeOutcomes = await runJudge(ctx, context, approveConfig.budgetUsd);
  const judge = mergeJudges(judgeOutcomes);
  if (judge && judge.status !== "no_plan") log(`  plan: ${judge.status}${judge.planEdited ? " (edited)" : ""}`);
  const outcomes = await runRubric(ctx, context, classification, judge, approveConfig.budgetUsd);
  const verdict = mergeVerdict({ context, outcomes, judge, classification });
  const body = renderBody(verdict, context);
  log(`  verdict: ${verdict.level}, ${verdict.approve ? "approve" : `not approved (${verdict.reasons.join("; ")})`}`);
  let posted = false;
  if (!opts.dryRun) {
    if (!deps.poster) throw new Error("brewery approve: no poster configured; use --dry-run or set the App credentials");
    await deps.poster.post({ context, verdict, body });
    posted = true;
    appendEvent(ctx.state, { kind: "pr", number: pr, url: `#${pr}` });
  }
  return { headSha: head, verdict, skipped: null, body, posted };
};

// Readers for a real checkout: policy from the base branch, plans from the head.
export const gitReaders = (repo: string, base: string, headSha: string): Pick<ApproveDeps, "readBase" | "readHead" | "baseSha"> => {
  // File contents untrimmed: sh() trims, and a plan's trailing newline is part of the text.
  const show = async (ref: string, path: string): Promise<string | null> => {
    const proc = Bun.spawn(["git", "show", `${ref}:${path}`], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out : null;
  };
  const baseRef = async (): Promise<string> => {
    try {
      await git(repo, "rev-parse", "--verify", "--quiet", `origin/${base}`);
      return `origin/${base}`;
    } catch {
      return base;
    }
  };
  return {
    readBase: async (path) => show(await baseRef(), path),
    readHead: async (path) => show(headSha, path),
    baseSha: async () => (await git(repo, "rev-parse", "--short", await baseRef())).trim(),
  };
};

export { checkRun };
