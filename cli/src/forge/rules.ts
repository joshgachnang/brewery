// The rules that make the two forges read the same: check buckets and the overall verdict,
// the approval rule, and how Forgejo review comments group into threads.
import type { Actor, Bucket, Check, ChecksState, Review, ReviewDecision, Thread, ThreadComment } from "./types.ts";

// GitHub's check states (CheckRun conclusions and StatusContext states, upper-cased) and
// Forgejo's commit status states map onto gh's buckets. Forgejo's `warning` does not block a
// merge there, so it counts as a pass.
export const bucketFor = (state: string): Bucket => {
  switch (state.toUpperCase()) {
    case "SUCCESS":
    case "NEUTRAL":
    case "WARNING":
      return "pass";
    case "FAILURE":
    case "ERROR":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
    case "STALE":
      return "fail";
    case "CANCELLED":
      return "cancel";
    case "SKIPPED":
      return "skipping";
    default:
      return "pending";
  }
};

// red if anything failed or was cancelled, else running if anything is still going, else
// green; none when there are no checks at all. Skipped checks alone are green.
export const checksState = (checks: Pick<Check, "bucket">[]): ChecksState => {
  if (checks.length === 0) return "none";
  if (checks.some((c) => c.bucket === "fail" || c.bucket === "cancel")) return "red";
  if (checks.some((c) => c.bucket === "pending")) return "running";
  return "green";
};

// gh pr checks' exit codes: 0 all passed, 1 something failed or no checks, 8 still pending.
export const checksExitCode = (state: ChecksState): number => (state === "green" ? 0 : state === "running" ? 8 : 1);

// Approved means the newest deciding review (an approval or a request for changes) from each
// reviewer other than the author includes an approval and no request for changes. Comments,
// pending and dismissed reviews decide nothing. Stale reviews still count.
export const decideReviews = (reviews: Review[], prAuthor: string): ReviewDecision => {
  const newest = new Map<string, Review>();
  const ordered = [...reviews].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  for (const review of ordered) {
    if (review.author.login === prAuthor) continue;
    if (review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED") continue;
    newest.set(review.author.login, review);
  }
  const states = [...newest.values()].map((r) => r.state);
  if (states.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  if (states.includes("APPROVED")) return "APPROVED";
  return "REVIEW_REQUIRED";
};

export const isBotLogin = (login: string, bots: string[] = []): boolean =>
  bots.includes(login) || /(\[bot\]|-bot)$/.test(login) || login.startsWith("app/");

export const actor = (login: string | undefined, bots: string[] = [], flag?: boolean): Actor => ({
  login: login ?? "",
  isBot: Boolean(flag) || isBotLogin(login ?? "", bots),
});

export interface ForgejoReviewComment {
  id: number;
  path: string;
  position: number;
  original_position: number;
  commit_id: string;
  original_commit_id?: string;
  resolver: { login: string } | null;
  user: { login: string } | null;
  body: string;
  created_at: string;
  html_url: string;
  pull_request_review_id: number;
}

// Forgejo has no thread object: a conversation is every review comment on the same file and
// line (new side by `position`, old side by `original_position`), which is how its UI groups
// them. The thread is resolved when Forgejo records a resolver on any of its comments. The API
// does not say whether a comment is outdated, so isOutdated is always false on Forgejo.
export const forgejoThreads = (comments: ForgejoReviewComment[], bots: string[] = []): Thread[] => {
  const groups = new Map<string, ForgejoReviewComment[]>();
  for (const c of [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)) {
    const key = `${c.path}\u0000${c.position ? `+${c.position}` : `-${c.original_position}`}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0];
    const resolvedBy = group.find((c) => c.resolver)?.resolver?.login;
    const out: ThreadComment[] = group.map((c) => ({
      id: String(c.id),
      author: actor(c.user?.login, bots),
      body: c.body ?? "",
      createdAt: c.created_at,
      url: c.html_url,
      ...(c.resolver ? { resolvedBy: c.resolver.login } : {}),
    }));
    return {
      id: String(first.id),
      path: first.path,
      line: first.position || first.original_position || null,
      isResolved: Boolean(resolvedBy),
      isOutdated: false,
      comments: out,
    };
  });
};

// gh's --created filter for runs, applied client-side where the forge has none: ">=", ">",
// "<=" or "<" before an ISO date or time, or a bare date meaning that whole day.
export const createdMatches = (filter: string, createdAt: string): boolean => {
  const m = filter.trim().match(/^(>=|<=|>|<)?\s*(\S+)$/);
  if (!m) return true;
  const [, op, when] = m;
  if (!op) return createdAt.startsWith(when);
  const at = Date.parse(createdAt);
  const bound = Date.parse(when);
  if (Number.isNaN(at) || Number.isNaN(bound)) return true;
  return op === ">=" ? at >= bound : op === ">" ? at > bound : op === "<=" ? at <= bound : at < bound;
};

// Forgejo marks a draft with a title prefix (its default WIP prefixes).
export const WIP_PREFIX = /^\s*(WIP:|\[WIP\])\s*/i;
