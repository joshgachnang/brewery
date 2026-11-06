// Peers for `brewery ui`: other `brewery ui` instances (the zerg host's, say) whose runs this
// one lists as `<peer>~<peer run id>` and whose per-run routes it proxies. The peer's token
// is added here, server-side; no response carries it, and errors name only a status code.
import type { RunSummary, SourceStatus } from "./runs.ts";

export interface Peer {
  id: string;
  url: string;
  token: string;
}

// A peer that has not answered the run list in this long is `unreachable`.
export const PEER_TIMEOUT_MS = 3_000;

// Source names a peer cannot take: they would shadow this instance's own run IDs.
const RESERVED = new Set(["local", "scan"]);

// `<name>=<url>#<token>` → a peer. Throws with a message that never repeats the token.
export const parsePeer = (spec: string): Peer => {
  const eq = spec.indexOf("=");
  // The first "#" after the name ends the URL, so a token may itself contain "#".
  const hash = eq > 0 ? spec.indexOf("#", eq) : -1;
  const id = eq > 0 ? spec.slice(0, eq).trim() : "";
  const url = eq > 0 && hash > eq ? spec.slice(eq + 1, hash).trim().replace(/\/+$/, "") : "";
  const token = hash > eq ? spec.slice(hash + 1).trim() : "";
  if (!id || !url || !token) throw new Error("brewery ui: --peer needs <name>=<url>#<token>");
  return checkPeer({ id, url, token });
};

const checkPeer = (peer: Peer): Peer => {
  if (RESERVED.has(peer.id) || !/^[A-Za-z0-9._-]+$/.test(peer.id)) {
    throw new Error(`brewery ui: peer name "${peer.id}" must be letters, digits, ".", "_" or "-", and not local or scan`);
  }
  let parsed: URL;
  try {
    parsed = new URL(peer.url);
  } catch {
    throw new Error(`brewery ui: peer "${peer.id}" needs an http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`brewery ui: peer "${peer.id}" needs an http(s) URL`);
  return { ...peer, url: peer.url.replace(/\/+$/, "") };
};

// Validates every peer and rejects a name used twice.
export const checkPeers = (peers: Peer[]): Peer[] => {
  const seen = new Set<string>();
  return peers.map((peer) => {
    const ok = checkPeer(peer);
    if (seen.has(ok.id)) throw new Error(`brewery ui: peer "${ok.id}" is given twice`);
    seen.add(ok.id);
    return ok;
  });
};

// `<peer>~<rest>` → the peer and the peer's own run ID, or undefined for any other source.
export const peerFor = (id: string, peers: Peer[]): { peer: Peer; inner: string } | undefined => {
  const sep = id.indexOf("~");
  if (sep < 0) return undefined;
  const peer = peers.find((p) => p.id === id.slice(0, sep));
  const inner = id.slice(sep + 1);
  return peer && inner ? { peer, inner } : undefined;
};

// Why a peer failed, without its URL or token: a status code, "timeout", or "connection failed".
const failure = (error: unknown): string => {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout";
  return "connection failed";
};

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// One peer's runs, renamed into this instance's ID space, and its source entry. Never throws.
export const peerRuns = async (peer: Peer, timeoutMs = PEER_TIMEOUT_MS): Promise<{ runs: RunSummary[]; source: SourceStatus }> => {
  const down = (detail: string): { runs: RunSummary[]; source: SourceStatus } => ({
    runs: [],
    source: { id: peer.id, kind: "peer", status: "unreachable", detail },
  });
  try {
    const res = await fetch(`${peer.url}/api/runs`, {
      headers: { "X-Brewery-Token": peer.token, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return down(String(res.status));
    }
    const body = (await res.json().catch(() => undefined)) as unknown;
    if (!isObject(body) || !Array.isArray(body.runs)) return down("bad response");
    const runs = body.runs
      .filter((run): run is RunSummary => isObject(run) && typeof run.id === "string" && typeof run.updatedAt === "string")
      .map((run) => ({ ...run, id: `${peer.id}~${run.id}`, source: peer.id }));
    return { runs, source: { id: peer.id, kind: "peer", status: "ok" } };
  } catch (error) {
    return down(failure(error));
  }
};

// Response headers worth passing back from a peer; nothing else (no cookies, no lengths a
// decompressed body would contradict).
const PASSED_HEADERS = ["content-type", "cache-control", "x-accel-buffering"];

// Forwards one per-run request to the peer as `/api/runs/<inner><rest>`, with the peer's token
// in place of ours. The query string is dropped, so this instance's `?token=` never leaves.
// The peer's status and body come back unchanged; an SSE body streams through. `track` lets
// the server abort open upstream streams when it stops.
export const proxyToPeer = async (
  req: Request,
  target: { peer: Peer; inner: string },
  rest: string,
  track: (ctl: AbortController) => () => void,
): Promise<Response> => {
  const { peer, inner } = target;
  const ctl = new AbortController();
  const untrack = track(ctl);
  const onAbort = (): void => ctl.abort();
  req.signal.addEventListener("abort", onAbort);
  const headers: Record<string, string> = { "X-Brewery-Token": peer.token };
  for (const name of ["content-type", "accept", "last-event-id"]) {
    const value = req.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  // Only the response headers are bounded by the timeout; an open SSE body is not.
  const timer = setTimeout(() => ctl.abort(), PEER_TIMEOUT_MS);
  const done = (): void => {
    clearTimeout(timer);
    req.signal.removeEventListener("abort", onAbort);
    untrack();
  };
  try {
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const res = await fetch(`${peer.url}/api/runs/${encodeURIComponent(inner)}${rest}`, {
      method: req.method,
      headers,
      ...(hasBody ? { body: await req.arrayBuffer() } : {}),
      signal: ctl.signal,
      redirect: "error",
    });
    clearTimeout(timer);
    const out = new Headers();
    for (const name of PASSED_HEADERS) {
      const value = res.headers.get(name);
      if (value !== null) out.set(name, value);
    }
    if (!res.body) {
      done();
      return new Response(null, { status: res.status, headers: out });
    }
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const { value, done: end } = await reader.read();
          if (end) {
            done();
            controller.close();
          } else controller.enqueue(value);
        } catch {
          done();
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        }
      },
      cancel: () => {
        ctl.abort();
        done();
      },
    });
    return new Response(body, { status: res.status, headers: out });
  } catch (error) {
    done();
    return Response.json({ error: `peer ${peer.id} unreachable (${failure(error)})` }, { status: 502, headers: { "cache-control": "no-store" } });
  }
};
