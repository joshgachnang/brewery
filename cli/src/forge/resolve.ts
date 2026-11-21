// Which forge a repo lives on. The host comes from `-R`, a URL argument, or the `origin`
// remote; `github.com` is GitHub, a host in ~/.config/forge/hosts.json is Forgejo, and any
// other host is an error rather than a guess.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sh } from "../vcs.ts";
import { ForgeError, type RepoRef } from "./types.ts";

export interface HostEntry {
  type: "forgejo";
  // Base URL of the web UI; the API is <url>/api/v1.
  url: string;
  token?: string;
  // Logins to treat as bots (Forgejo has no bot flag); `*-bot` and `*[bot]` always are.
  bots?: string[];
}

export type Hosts = Record<string, HostEntry>;

export interface Slug {
  host: string | null;
  owner: string;
  name: string;
}

const stripGit = (name: string): string => name.replace(/\.git$/, "");

// owner/name from a remote URL, a web URL (PR, run, issue links included), HOST/OWNER/REPO,
// or a bare OWNER/REPO (host null).
export const parseSlug = (input: string): Slug | null => {
  const value = input.trim().replace(/\/+$/, "");
  const url = value.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/?#]+)/i);
  if (url) return { host: url[1].toLowerCase(), owner: url[2], name: stripGit(url[3]) };
  const scp = value.match(/^(?:[^@/]+@)?([^/:]+):([^/]+)\/([^/]+?)$/);
  if (scp) return { host: scp[1].toLowerCase(), owner: scp[2], name: stripGit(scp[3]) };
  const hostSlug = value.match(/^([^/]+\.[^/]+)\/([^/]+)\/([^/]+)$/);
  if (hostSlug) return { host: hostSlug[1].toLowerCase(), owner: hostSlug[2], name: stripGit(hostSlug[3]) };
  const bare = value.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (bare) return { host: null, owner: bare[1], name: stripGit(bare[2]) };
  return null;
};

export const hostsPath = (env: NodeJS.ProcessEnv = process.env): string =>
  env.FORGE_HOSTS || join(env.HOME || homedir(), ".config", "forge", "hosts.json");

export const loadHosts = (path: string): Hosts => {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ForgeError(`forge: ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ForgeError(`forge: ${path} must be an object keyed by host`);
  const hosts: Hosts = {};
  for (const [host, entry] of Object.entries(raw as Record<string, Partial<HostEntry>>)) {
    if (entry?.type !== "forgejo") throw new ForgeError(`forge: ${path}: ${host}: type must be "forgejo"`);
    if (typeof entry.url !== "string" || !/^https?:\/\//.test(entry.url)) throw new ForgeError(`forge: ${path}: ${host}: url must be an http(s) URL`);
    hosts[host.toLowerCase()] = { type: "forgejo", url: entry.url.replace(/\/+$/, ""), token: entry.token, bots: entry.bots };
  }
  // A token in a world-readable file is a leak waiting to happen; say so, don't refuse.
  if (Object.values(hosts).some((h) => h.token) && (statSync(path).mode & 0o077) !== 0) {
    console.error(`forge: warning: ${path} holds a token and is readable by others; chmod 600 it`);
  }
  return hosts;
};

export const originUrl = async (cwd: string): Promise<string | null> => {
  const res = await sh(cwd, ["git", "remote", "get-url", "origin"]);
  return res.code === 0 && res.out ? res.out : null;
};

export interface Resolved {
  ref: RepoRef;
  entry?: HostEntry;
  token?: string;
}

export const forgeFor = (slug: Slug & { host: string }, hosts: Hosts, env: NodeJS.ProcessEnv = process.env): Resolved => {
  if (slug.host === "github.com") return { ref: { forge: "github", host: slug.host, owner: slug.owner, name: slug.name } };
  const entry = hosts[slug.host];
  if (!entry) {
    throw new ForgeError(`forge: unknown host ${slug.host}; add it to ${hostsPath(env)} (see cli/README.md) or use a github.com repo`);
  }
  return { ref: { forge: "forgejo", host: slug.host, owner: slug.owner, name: slug.name }, entry, token: entry.token || env.FORGEJO_TOKEN || undefined };
};

// The repo a command acts on: -R wins, then a URL given as the command's argument, then origin.
// A bare OWNER/REPO borrows origin's host, and is an error outside a checkout.
export const resolveRepo = async (opts: { repo?: string; urlArg?: string; cwd: string; env?: NodeJS.ProcessEnv }): Promise<Resolved> => {
  const env = opts.env ?? process.env;
  const hosts = loadHosts(hostsPath(env));
  const fromArg = opts.urlArg && /^(https?|ssh):\/\//.test(opts.urlArg) ? opts.urlArg : undefined;
  const given = opts.repo ?? fromArg;
  let slug = given ? parseSlug(given) : null;
  if (given && !slug) throw new ForgeError(`forge: cannot read a repo from ${given}; use OWNER/REPO, HOST/OWNER/REPO, or a URL`);
  if (!slug || !slug.host) {
    const origin = await originUrl(opts.cwd);
    const fromOrigin = origin ? parseSlug(origin) : null;
    if (!fromOrigin?.host) {
      throw new ForgeError(
        given
          ? `forge: ${given} names no host and there is no origin remote here to take one from; use HOST/OWNER/REPO or a URL`
          : "forge: no origin remote here; run inside a checkout or pass -R HOST/OWNER/REPO",
      );
    }
    slug = slug ? { ...slug, host: fromOrigin.host } : fromOrigin;
  }
  return forgeFor(slug as Slug & { host: string }, hosts, env);
};
