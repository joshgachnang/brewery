// The brewery side of forge: changed files read from a diff, and cellar/calibrate's Forgejo
// path, which has no search qualifiers and filters dates itself.
import { describe, expect, test } from "bun:test";
import { filesFromDiff } from "../src/forge/ci.ts";
import { forgejoForge, repoName } from "../src/forge/history.ts";
import type { Backend, Pr, PrListOpts, Thread } from "../src/forge/types.ts";

const pr = (n: number, over: Partial<Pr>): Pr => ({
  forge: "forgejo",
  repo: "o/r",
  number: n,
  url: `https://forgejo.example/o/r/pulls/${n}`,
  title: `PR ${n}`,
  body: "",
  state: "OPEN",
  isDraft: false,
  author: { login: "josh", isBot: false },
  headRefName: `b${n}`,
  headRefOid: "abc",
  baseRefName: "master",
  labels: [],
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "REVIEW_REQUIRED",
  approvedAtHead: false,
  reviews: [],
  comments: [],
  checks: [],
  checksState: "none",
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  ...over,
});

const fakeBackend = (prs: Pr[], threads: Record<number, Thread[]> = {}): Backend & { lists: PrListOpts[] } => {
  const lists: PrListOpts[] = [];
  return {
    lists,
    prList: async (o: PrListOpts) => {
      lists.push(o);
      if (o.search) throw new Error("search is GitHub-only");
      return prs.filter((p) => o.state === "all" || (o.state === "merged" ? p.state === "MERGED" : p.state === o.state.toUpperCase())).slice(0, o.limit);
    },
    prView: async (sel: string | undefined) => prs.find((p) => String(p.number) === sel)!,
    prThreads: async (sel: string | undefined) => threads[Number(sel)] ?? [],
  } as unknown as Backend & { lists: PrListOpts[] };
};

describe("filesFromDiff", () => {
  test("counts added and removed lines per file, including renames and deletions", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@",
      " keep",
      "-old",
      "+new",
      "+++plus content starting with pluses",
      "diff --git a/old.md b/new.md",
      "similarity index 90%",
      "rename from old.md",
      "rename to new.md",
      "--- a/old.md",
      "+++ b/new.md",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-one",
      "-two",
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
    ].join("\n");
    expect(filesFromDiff(diff)).toEqual([
      { path: "src/a.ts", additions: 2, deletions: 1 },
      { path: "new.md", additions: 1, deletions: 1 },
      { path: "gone.txt", additions: 0, deletions: 2 },
      { path: "img.png", additions: 0, deletions: 0 },
    ]);
  });
});

describe("cellar and calibrate on Forgejo", () => {
  test("a bare owner/name is GitHub, a host-qualified one names its host", () => {
    expect(repoName("joshgachnang/brewery")).toEqual({ host: "github.com", slug: "joshgachnang/brewery" });
    expect(repoName("forgejo.nang.io/joshgachnang/brewery")).toEqual({ host: "forgejo.nang.io", slug: "joshgachnang/brewery" });
  });

  test("merged PRs are filtered by merge date without a search qualifier", async () => {
    const b = fakeBackend([
      pr(3, { state: "MERGED", mergedAt: "2026-11-10T00:00:00Z" }),
      pr(2, { state: "MERGED", mergedAt: "2026-10-01T00:00:00Z" }),
      pr(4, { state: "MERGED", mergedAt: "2026-11-12T00:00:00Z" }),
      pr(5, { state: "OPEN" }),
    ]);
    const merged = await forgejoForge(b).mergedPrs("o/r", "2026-11-05T00:00:00Z");
    expect(merged.map((m) => m.number)).toEqual([4, 3]);
    expect(b.lists.every((o) => !o.search)).toBe(true);
  });

  test("reviewed PRs keep only those updated in the window, with reviews, inline and conversation notes", async () => {
    const human = { login: "josh", isBot: false };
    const b = fakeBackend(
      [
        pr(7, {
          updatedAt: "2026-11-11T00:00:00Z",
          state: "MERGED",
          reviews: [{ id: "1", author: human, state: "CHANGES_REQUESTED", body: "no", submittedAt: "2026-11-10T01:00:00Z", commit: { oid: "abc" }, stale: false }],
          comments: [
            { id: "c1", author: human, body: "old", createdAt: "2026-10-01T00:00:00Z", url: "" },
            { id: "c2", author: human, body: "new", createdAt: "2026-11-10T02:00:00Z", url: "" },
          ],
        }),
        pr(6, { updatedAt: "2026-10-01T00:00:00Z" }),
      ],
      { 7: [{ id: "t1", path: "a.ts", line: 4, isResolved: false, isOutdated: false, comments: [{ id: "i1", author: human, body: "rename", createdAt: "2026-11-10T03:00:00Z", url: "" }] }] },
    );
    const prs = await forgejoForge(b).reviewedPrs("o/r", "2026-11-05T00:00:00Z");
    expect(prs.map((p) => p.number)).toEqual([7]);
    expect(prs[0].state).toBe("merged");
    expect(prs[0].notes.map((n) => `${n.kind}:${n.body}`)).toEqual(["review:no", "comment:new", "inline:rename"]);
    expect(prs[0].notes.find((n) => n.kind === "inline")).toMatchObject({ path: "a.ts", line: 4 });
  });
});
