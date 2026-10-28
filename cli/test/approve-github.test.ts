import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import type { ApproveContext } from "../src/approve/context.ts";
import { githubPoster } from "../src/approve/github.ts";
import { NO_PLAN } from "../src/approve/judge.ts";
import type { Verdict } from "../src/approve/review.ts";
import { appJwt, installationToken, normalizePem, type Fetch } from "../src/approve/token.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;

const decode = (part: string): Record<string, unknown> => JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));

interface Call {
  method: string;
  url: string;
  auth?: string;
  body?: unknown;
}

// A scripted GitHub: records every call, answers by method+path prefix, 200 otherwise.
const fakeGitHub = (routes: Record<string, { status?: number; json?: unknown }> = {}): Fetch & { calls: Call[] } => {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const headers = init.headers as Record<string, string> | undefined;
    calls.push({ method, url, auth: headers?.Authorization, body: init.body ? JSON.parse(init.body as string) : undefined });
    const key = Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
    const route = key ? routes[key] : {};
    const status = route.status ?? 200;
    return new Response(JSON.stringify(route.json ?? {}), { status, headers: { "Content-Type": "application/json" } });
  }) as Fetch & { calls: Call[] };
  fn.calls = calls;
  return fn;
};

describe("App token", () => {
  test("the JWT carries iss, iat a minute back, exp nine minutes ahead, and verifies with the public key", () => {
    const jwt = appJwt("12345", pem, 1_700_000_000);
    const [header, claims, signature] = jwt.split(".");
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(claims)).toEqual({ iat: 1_699_999_940, exp: 1_700_000_540, iss: "12345" });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify(publicKey, Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64"))).toBe(true);
  });

  test("the private key may arrive with literal \\n or base64-wrapped", () => {
    expect(normalizePem(pem.replace(/\n/g, "\\n"))).toBe(pem);
    expect(normalizePem(Buffer.from(pem).toString("base64"))).toBe(pem);
    expect(() => normalizePem("nope")).toThrow("not a PEM");
  });

  test("minting resolves the slug and installation, then posts for a token", async () => {
    const gh = fakeGitHub({
      "GET https://api.github.com/app": { json: { slug: "terreno-approve" } },
      "GET https://api.github.com/repos/acme/widgets/installation": { json: { id: 777 } },
      "POST https://api.github.com/app/installations/777/access_tokens": { json: { token: "ghs_minted" } },
    });
    const auth = await installationToken({ repo: "acme/widgets", env: { TERRENO_APP_ID: "12345", TERRENO_APP_PRIVATE_KEY: pem }, fetch: gh, now: 1_700_000_000 });
    expect(auth).toEqual({ token: "ghs_minted", appLogin: "terreno-approve[bot]" });
    expect(gh.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/app",
      "GET https://api.github.com/repos/acme/widgets/installation",
      "POST https://api.github.com/app/installations/777/access_tokens",
    ]);
    expect(gh.calls.every((c) => c.auth?.startsWith("Bearer ey"))).toBe(true);
  });

  test("a known slug and installation id skip the lookups; a pre-minted token skips everything", async () => {
    const gh = fakeGitHub({ "POST https://api.github.com/app/installations/9/access_tokens": { json: { token: "ghs_x" } } });
    const auth = await installationToken({ repo: "a/b", env: { TERRENO_APP_ID: "1", TERRENO_APP_PRIVATE_KEY: pem, TERRENO_APP_SLUG: "my-app", TERRENO_APP_INSTALLATION_ID: "9" }, fetch: gh });
    expect(auth).toEqual({ token: "ghs_x", appLogin: "my-app[bot]" });
    expect(gh.calls).toHaveLength(1);
    const direct = fakeGitHub();
    expect(await installationToken({ repo: "a/b", env: { TERRENO_APPROVE_TOKEN: "ghp_local" }, fetch: direct })).toEqual({ token: "ghp_local", appLogin: "terreno-approval-agent[bot]" });
    expect(direct.calls).toHaveLength(0);
    await expect(installationToken({ repo: "a/b", env: {}, fetch: direct })).rejects.toThrow("TERRENO_APP_ID");
  });

  test("a failed GitHub call names the request and status", async () => {
    const gh = fakeGitHub({ "GET https://api.github.com/app": { status: 401, json: { message: "Bad credentials" } } });
    await expect(installationToken({ repo: "a/b", env: { TERRENO_APP_ID: "1", TERRENO_APP_PRIVATE_KEY: pem }, fetch: gh })).rejects.toThrow("GET https://api.github.com/app → 401");
  });
});

const context = (headSha = "abc123"): ApproveContext =>
  ({ pr: { number: 7, headSha, checks: [] }, policy: { source: "master@1", rubric: null, approve: { rubric: "x" } } }) as never;

const verdict = (approve: boolean, over: Partial<Verdict> = {}): Verdict => ({
  level: approve ? "low" : "medium",
  approve,
  reasons: approve ? [] : ["risk medium is above the configured approval levels (low)"],
  dimensions: { ipMatch: { score: 3, reasons: ["fine"] }, architecture: { score: 3, reasons: [] }, tests: { score: 3, reasons: [] }, evidence: { score: 3, reasons: [] } },
  findings: [],
  rationale: "Looks fine.",
  classification: { categories: ["docs"], floor: null, ceiling: "low", never: [] },
  gates: { checks: "pass", botThreads: 0, humanChangesRequested: false, size: "ok" },
  judge: NO_PLAN,
  agents: ["claude"],
  errors: [],
  modelLevel: approve ? "low" : "medium",
  ...over,
});

const body = (sha: string): string => `<!-- terreno-approve:${sha} -->\n**Risk: low — approved.** fine\n`;

describe("GitHub poster", () => {
  test("approves with a review on the head and a successful check run", async () => {
    const gh = fakeGitHub({ "GET https://api.github.com/repos/acme/widgets/pulls/7/reviews": { json: [] } });
    const poster = githubPoster({ repo: "acme/widgets", token: "t", appLogin: "terreno-approve[bot]", fetch: gh });
    await poster.post({ context: context(), verdict: verdict(true), body: body("abc123") });
    const review = gh.calls.find((c) => c.method === "POST" && c.url.endsWith("/pulls/7/reviews"));
    expect(review?.body).toEqual({ commit_id: "abc123", event: "APPROVE", body: body("abc123") });
    expect(review?.auth).toBe("Bearer t");
    const check = gh.calls.find((c) => c.url.endsWith("/check-runs"));
    expect(check?.body).toEqual({ name: "terreno/approve", head_sha: "abc123", status: "completed", conclusion: "success", output: { title: "Risk: low — approved", summary: "Looks fine." } });
    expect(poster.last).toEqual({ reviewed: "posted", event: "APPROVE", dismissed: [], dismissFailed: [], check: { conclusion: "success", title: "Risk: low — approved" } });
  });

  test("an existing review with this head's marker is not posted twice", async () => {
    const gh = fakeGitHub({
      "GET https://api.github.com/repos/acme/widgets/pulls/7/reviews": { json: [{ id: 1, user: { login: "terreno-approve" }, state: "APPROVED", body: body("abc123") }] },
    });
    const poster = githubPoster({ repo: "acme/widgets", token: "t", appLogin: "terreno-approve[bot]", fetch: gh });
    await poster.post({ context: context(), verdict: verdict(true), body: body("abc123") });
    expect(gh.calls.filter((c) => c.method === "POST" && c.url.endsWith("/reviews"))).toHaveLength(0);
    expect(poster.last.reviewed).toBe("already");
    expect(poster.last.check?.conclusion).toBe("success");
  });

  test("a later head that is not approved comments, dismisses the App's stale approval, and posts a neutral check", async () => {
    const gh = fakeGitHub({
      "GET https://api.github.com/repos/acme/widgets/pulls/7/reviews": {
        json: [
          { id: 1, user: { login: "terreno-approve" }, state: "APPROVED", body: body("old111") },
          { id: 2, user: { login: "kim" }, state: "APPROVED", body: "lgtm" },
        ],
      },
    });
    const poster = githubPoster({ repo: "acme/widgets", token: "t", appLogin: "terreno-approve[bot]", fetch: gh });
    await poster.post({ context: context("new222"), verdict: verdict(false), body: "<!-- terreno-approve:new222 -->\n**Risk: medium — not approved.** x\n" });
    const review = gh.calls.find((c) => c.method === "POST" && c.url.endsWith("/pulls/7/reviews"));
    expect(review?.body).toMatchObject({ event: "COMMENT", commit_id: "new222" });
    const dismissal = gh.calls.find((c) => c.method === "PUT");
    expect(dismissal?.url).toBe("https://api.github.com/repos/acme/widgets/pulls/7/reviews/1/dismissals");
    expect(dismissal?.body).toEqual({ message: "✋ 🟡 Risk: medium — not approved. risk medium is above the configured approval levels (low)" });
    expect(gh.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(poster.last.dismissed).toEqual([1]);
    expect(poster.last.check?.conclusion).toBe("neutral");
  });

  test("a dismissal the branch forbids is recorded in the check summary, not thrown", async () => {
    const gh = fakeGitHub({
      "GET https://api.github.com/repos/acme/widgets/pulls/7/reviews": { json: [{ id: 5, user: { login: "terreno-approve[bot]" }, state: "APPROVED", body: body("old111") }] },
      "PUT https://api.github.com/repos/acme/widgets/pulls/7/reviews/5/dismissals": { status: 403, json: { message: "forbidden" } },
    });
    const poster = githubPoster({ repo: "acme/widgets", token: "t", appLogin: "terreno-approve[bot]", fetch: gh });
    await poster.post({ context: context("new222"), verdict: verdict(false), body: "<!-- terreno-approve:new222 -->\nx\n" });
    expect(poster.last.dismissFailed).toEqual(["5: 403"]);
    const check = gh.calls.find((c) => c.url.endsWith("/check-runs"));
    expect((check?.body as { output: { summary: string } }).output.summary).toContain("Could not dismiss the App's earlier approval (5: 403)");
  });

  test("an approval does not dismiss anything and a failed review post throws", async () => {
    const gh = fakeGitHub({
      "GET https://api.github.com/repos/acme/widgets/pulls/7/reviews": { json: [{ id: 1, user: { login: "terreno-approve" }, state: "APPROVED", body: body("old111") }] },
      "POST https://api.github.com/repos/acme/widgets/pulls/7/reviews": { status: 422, json: { message: "Can not approve your own pull request" } },
    });
    const poster = githubPoster({ repo: "acme/widgets", token: "t", appLogin: "terreno-approve[bot]", fetch: gh });
    await expect(poster.post({ context: context("new222"), verdict: verdict(true), body: body("new222") })).rejects.toThrow("422");
    expect(gh.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  test("a skip writes only a skipped check run", async () => {
    const gh = fakeGitHub();
    const poster = githubPoster({ repo: "acme/widgets", token: "t", appLogin: "terreno-approve[bot]", fetch: gh });
    await poster.skip({ context: context(), reason: "draft pull request", body: "" });
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0].body).toMatchObject({ name: "terreno/approve", head_sha: "abc123", conclusion: "skipped", output: { title: "Skipped: draft pull request" } });
  });
});
