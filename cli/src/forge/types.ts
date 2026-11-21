// The one schema `forge --json` prints for both forges. Field names follow gh's `--json`
// names wherever gh has one, so `gh pr view --json headRefOid -q .headRefOid` becomes
// `forge pr view --json headRefOid -q .headRefOid`. Values are normalized: the same field
// means the same thing on GitHub and on Forgejo. cli/README.md documents every field.

export type ForgeKind = "github" | "forgejo";

export interface RepoRef {
  forge: ForgeKind;
  host: string;
  owner: string;
  name: string;
}

export interface Actor {
  login: string;
  isBot: boolean;
}

// gh's buckets, so callers of `gh pr checks --json bucket` keep working.
export type Bucket = "pass" | "fail" | "pending" | "skipping" | "cancel";

// One verdict for a set of checks.
export type ChecksState = "green" | "red" | "running" | "none";

export interface Check {
  name: string;
  // The forge's own state, upper-cased (SUCCESS, FAILURE, PENDING, ERROR, SKIPPED, ...).
  state: string;
  bucket: Bucket;
  link: string;
  workflow: string;
  description: string;
  startedAt: string;
  completedAt: string;
  event: string;
}

export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";

export interface Review {
  id: string;
  author: Actor;
  state: ReviewState;
  body: string;
  submittedAt: string;
  commit: { oid: string };
  // Forgejo marks a review stale once the head moves past it; GitHub has no such flag (false).
  stale: boolean;
}

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";

export interface Comment {
  id: string;
  author: Actor;
  body: string;
  createdAt: string;
  url: string;
}

export interface Pr {
  forge: ForgeKind;
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  author: Actor;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  labels: { name: string }[];
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;
  reviewDecision: ReviewDecision;
  // APPROVED, and an approval that decides it was given on headRefOid.
  approvedAtHead: boolean;
  reviews: Review[];
  comments: Comment[];
  checks: Check[];
  checksState: ChecksState;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
}

export interface ThreadComment extends Comment {
  // Set when the forge says who resolved the thread at this comment (Forgejo's `resolver`).
  resolvedBy?: string;
}

export interface Thread {
  id: string;
  path: string;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  comments: ThreadComment[];
}

export type RunStatus = "queued" | "in_progress" | "completed";
export type RunConclusion = "success" | "failure" | "cancelled" | "skipped" | "";

export interface Job {
  databaseId: number;
  name: string;
  status: RunStatus;
  conclusion: RunConclusion;
  url: string;
  startedAt: string;
  completedAt: string;
}

export interface Run {
  forge: ForgeKind;
  repo: string;
  // The id `forge run <cmd> <id>` takes, and the number in the run's URL: GitHub's run id,
  // Forgejo's run number (`index_in_repo`).
  databaseId: number;
  number: number;
  url: string;
  workflowName: string;
  displayTitle: string;
  headBranch: string;
  headSha: string;
  event: string;
  status: RunStatus;
  conclusion: RunConclusion;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  jobs: Job[];
}

export interface Issue {
  forge: ForgeKind;
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  author: Actor;
  labels: { name: string }[];
  assignees: { login: string }[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Repo {
  forge: ForgeKind;
  host: string;
  name: string;
  owner: { login: string };
  nameWithOwner: string;
  url: string;
  sshUrl: string;
  cloneUrl: string;
  defaultBranchRef: { name: string };
  isPrivate: boolean;
}

export interface PrListOpts {
  state: "open" | "closed" | "merged" | "all";
  limit: number;
  head?: string;
  base?: string;
  author?: string;
  label?: string;
  search?: string;
}

export interface PrCreateOpts {
  title: string;
  body: string;
  base?: string;
  head: string;
  draft: boolean;
}

export interface MergeOpts {
  method: "merge" | "squash" | "rebase";
  matchHead?: string;
  deleteBranch: boolean;
}

export interface RunListOpts {
  limit: number;
  branch?: string;
  commit?: string;
  workflow?: string;
  status?: string;
  event?: string;
  // gh's --created: ">=2026-11-01", "<2026-11-01T12:00:00Z", or a bare date (that day).
  created?: string;
}

export interface PrEditOpts {
  title?: string;
  body?: string;
  addReviewers: string[];
  removeReviewers: string[];
  addLabels: string[];
  removeLabels: string[];
}

export type ReviewEvent = "approve" | "request-changes" | "comment";

export interface IssueCreateOpts {
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
}

export interface LabelCreateOpts {
  name: string;
  color: string;
  description: string;
  // Update the label when it already exists, like gh label create --force.
  force: boolean;
}

export interface IssueListOpts {
  state: "open" | "closed" | "all";
  limit: number;
  label?: string;
  search?: string;
}

// What every forge implements. A selector is a number, a URL, or (for PRs) a branch name;
// undefined means the PR for the current branch.
export interface Backend {
  ref: RepoRef;
  prView: (sel: string | undefined) => Promise<Pr>;
  prList: (opts: PrListOpts) => Promise<Pr[]>;
  prCreate: (opts: PrCreateOpts) => Promise<string>;
  prDiff: (sel: string | undefined) => Promise<string>;
  prChecks: (sel: string | undefined) => Promise<Check[]>;
  prMerge: (sel: string | undefined, opts: MergeOpts) => Promise<void>;
  prComment: (sel: string | undefined, body: string) => Promise<string>;
  prThreads: (sel: string | undefined) => Promise<Thread[]>;
  // Mark ready for review, or back to draft with undo.
  prReady: (sel: string | undefined, undo: boolean) => Promise<void>;
  prEdit: (sel: string | undefined, opts: PrEditOpts) => Promise<void>;
  // Returns the review's URL where the forge gives one.
  prReview: (sel: string | undefined, event: ReviewEvent, body: string) => Promise<string>;
  runList: (opts: RunListOpts) => Promise<Run[]>;
  runView: (id: string) => Promise<Run>;
  runRerun: (id: string, opts: { failed: boolean; job?: string }) => Promise<void>;
  runLogs: (id: string, opts: { failed: boolean; job?: string }) => Promise<string>;
  issueList: (opts: IssueListOpts) => Promise<Issue[]>;
  issueView: (sel: string) => Promise<Issue>;
  issueClose: (sel: string, opts: { comment?: string; reason?: string }) => Promise<void>;
  issueComment: (sel: string, body: string) => Promise<string>;
  issueLabel: (sel: string, add: string[], remove: string[]) => Promise<string[]>;
  issueCreate: (opts: IssueCreateOpts) => Promise<string>;
  labelCreate: (opts: LabelCreateOpts) => Promise<void>;
  repoView: () => Promise<Repo>;
  repoClone: (dir: string | undefined, gitArgs: string[]) => Promise<void>;
  // Raw API passthrough; writes the response to stdout and returns the exit code.
  api: (args: string[]) => Promise<number>;
}

export class ForgeError extends Error {
  // Exit code main() uses for this error.
  code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}
