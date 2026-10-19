// A GitHub App installation token for the post step, minted from the App id and private
// key in the CI environment. BREWERY_APPROVE_TOKEN short-circuits minting for local runs.
import { createSign } from "node:crypto";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const API = "https://api.github.com";

const b64url = (input: string | Buffer): string => Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

// PEM from an env var: literal "\n" sequences or a base64-wrapped block are both accepted.
export const normalizePem = (raw: string): string => {
  const text = raw.trim().replace(/\\n/g, "\n");
  if (text.includes("-----BEGIN")) return text.endsWith("\n") ? text : `${text}\n`;
  const decoded = Buffer.from(text, "base64").toString("utf8");
  if (decoded.includes("-----BEGIN")) return decoded.endsWith("\n") ? decoded : `${decoded}\n`;
  throw new Error("brewery approve: BREWERY_APP_PRIVATE_KEY is not a PEM private key");
};

// RS256 JWT the App authenticates with: issued a minute ago, valid for nine more.
export const appJwt = (appId: string, pem: string, now = Math.floor(Date.now() / 1000)): string => {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(normalizePem(pem)))}`;
};

export interface AppAuth {
  token: string;
  // The App's login as it appears on reviews: "<slug>[bot]".
  appLogin: string;
}

const ghJson = async <T>(fetchFn: Fetch, url: string, auth: string, init: RequestInit = {}): Promise<T> => {
  const res = await fetchFn(url, {
    ...init,
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: auth, "User-Agent": "brewery-approve", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`brewery approve: ${init.method ?? "GET"} ${url} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
};

export const installationToken = async (input: {
  repo: string;
  env: Record<string, string | undefined>;
  fetch?: Fetch;
  now?: number;
}): Promise<AppAuth> => {
  const { env } = input;
  const fetchFn = input.fetch ?? fetch;
  const slugLogin = (slug: string): string => (slug.endsWith("[bot]") ? slug : `${slug}[bot]`);
  if (env.BREWERY_APPROVE_TOKEN) {
    return { token: env.BREWERY_APPROVE_TOKEN, appLogin: slugLogin(env.BREWERY_APP_SLUG ?? "brewery-approve") };
  }
  if (!env.BREWERY_APP_ID || !env.BREWERY_APP_PRIVATE_KEY) {
    throw new Error("brewery approve: set BREWERY_APP_ID and BREWERY_APP_PRIVATE_KEY (or BREWERY_APPROVE_TOKEN)");
  }
  const jwt = `Bearer ${appJwt(env.BREWERY_APP_ID, env.BREWERY_APP_PRIVATE_KEY, input.now)}`;
  const slug = env.BREWERY_APP_SLUG ?? (await ghJson<{ slug: string }>(fetchFn, `${API}/app`, jwt)).slug;
  const installationId = env.BREWERY_APP_INSTALLATION_ID ?? String((await ghJson<{ id: number }>(fetchFn, `${API}/repos/${input.repo}/installation`, jwt)).id);
  const minted = await ghJson<{ token: string }>(fetchFn, `${API}/app/installations/${installationId}/access_tokens`, jwt, { method: "POST" });
  return { token: minted.token, appLogin: slugLogin(slug) };
};
