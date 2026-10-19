// Post a verdict to GitHub as the App: one review per head, a check run, and the
// dismissal of the App's own stale approval when a later head is not approved.
import type { Poster } from "../commands/approve.ts";
import type { ApproveContext } from "./context.ts";
import { checkRun, firstLine, markerSha } from "./render.ts";
import { CHECK_NAME } from "./review.ts";
import type { Fetch } from "./token.ts";

const API = "https://api.github.com";

interface RestReview {
  id: number;
  user: { login: string } | null;
  state: string;
  body: string;
  commit_id?: string;
}

export interface PostLog {
  reviewed: "posted" | "already" | null;
  event: "APPROVE" | "COMMENT" | null;
  dismissed: number[];
  dismissFailed: string[];
  check: { conclusion: string; title: string } | null;
}

const sameLogin = (login: string, appLogin: string): boolean => {
  const bare = appLogin.replace(/\[bot\]$/, "");
  return login === bare || login === `${bare}[bot]`;
};

export const githubPoster = (input: { repo: string; token: string; appLogin: string; fetch?: Fetch; log?: (line: string) => void }): Poster & { last: PostLog } => {
  const fetchFn = input.fetch ?? fetch;
  const log = input.log ?? (() => {});
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${input.token}`,
    "User-Agent": "brewery-approve",
    "Content-Type": "application/json",
  };
  const call = async <T>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T | null; text: string }> => {
    const res = await fetchFn(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data: T | null = null;
    try {
      data = text ? (JSON.parse(text) as T) : null;
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data, text };
  };
  const must = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await call<T>(method, path, body);
    if (!res.ok) throw new Error(`brewery approve: ${method} ${path} → ${res.status} ${res.text.slice(0, 200)}`);
    return res.data as T;
  };
  const myReviews = async (pr: number): Promise<RestReview[]> => {
    const all: RestReview[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await must<RestReview[]>("GET", `/repos/${input.repo}/pulls/${pr}/reviews?per_page=100&page=${page}`);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all.filter((r) => r.user && sameLogin(r.user.login, input.appLogin));
  };
  const postCheck = async (context: ApproveContext, conclusion: string, title: string, summary: string): Promise<void> => {
    await must("POST", `/repos/${input.repo}/check-runs`, {
      name: CHECK_NAME,
      head_sha: context.pr.headSha,
      status: "completed",
      conclusion,
      output: { title: title.slice(0, 255), summary: summary.slice(0, 65_000) || title },
    });
    poster.last.check = { conclusion, title };
  };

  const poster: Poster & { last: PostLog } = {
    appLogin: input.appLogin,
    last: { reviewed: null, event: null, dismissed: [], dismissFailed: [], check: null },
    post: async ({ context, verdict, body }) => {
      poster.last = { reviewed: null, event: null, dismissed: [], dismissFailed: [], check: null };
      const pr = context.pr.number;
      const head = context.pr.headSha;
      const mine = await myReviews(pr);
      const event: "APPROVE" | "COMMENT" = verdict.approve ? "APPROVE" : "COMMENT";
      const existing = mine.find((r) => markerSha(r.body) === head && r.state !== "DISMISSED");
      if (existing && (existing.state === "APPROVED") === verdict.approve) {
        log(`  review: already ${existing.state.toLowerCase()} at ${head.slice(0, 7)}`);
        poster.last.reviewed = "already";
      } else {
        await must("POST", `/repos/${input.repo}/pulls/${pr}/reviews`, { commit_id: head, event, body });
        log(`  review: ${event} at ${head.slice(0, 7)}`);
        poster.last.reviewed = "posted";
      }
      poster.last.event = event;
      if (!verdict.approve) {
        for (const stale of mine.filter((r) => r.state === "APPROVED" && markerSha(r.body) !== head)) {
          const res = await call("PUT", `/repos/${input.repo}/pulls/${pr}/reviews/${stale.id}/dismissals`, { message: firstLine(verdict).replace(/\*\*/g, "") });
          if (res.ok) poster.last.dismissed.push(stale.id);
          else poster.last.dismissFailed.push(`${stale.id}: ${res.status}`);
          log(`  dismiss ${stale.id}: ${res.ok ? "ok" : `failed (${res.status})`}`);
        }
      }
      const check = checkRun(verdict);
      const summary = poster.last.dismissFailed.length
        ? `${check.summary}\n\nCould not dismiss the App's earlier approval (${poster.last.dismissFailed.join(", ")}); that approval is stale.`
        : check.summary;
      await postCheck(context, check.conclusion, check.title, summary);
    },
    skip: async ({ context, reason }) => {
      poster.last = { reviewed: null, event: null, dismissed: [], dismissFailed: [], check: null };
      await postCheck(context, "skipped", `Skipped: ${reason}`, `brewery approve did not review this head: ${reason}.`);
    },
  };
  return poster;
};
