// `brewery ui`: a token-guarded HTTP server for the run list and a scrubbed live event
// stream of one run. GET / serves the page; every /api/* request needs the token and a
// Host header naming the bound host or localhost.
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import pageText from "./page.html" with { type: "text" };
import { redactLine } from "./redact.ts";
import { answerRoute } from "./routes/answer.ts";
import { stepRoute } from "./routes/step.ts";
import { STATE_UNREADABLE, stateWatcher, viewRoute } from "./routes/view.ts";
import { findRun, listRuns, runUnreadable, type RunRef, type RunsContext } from "./runs.ts";
import { resumeOffset, tailer } from "./tail.ts";

// T11 fills these in; T1 accepts and ignores them so the signature is stable.
export interface Peer {
  id: string;
  url: string;
  token: string;
}

export interface UiOptions {
  repo: string;
  port: number;
  host: string;
  token: string;
  scan?: string[];
  peers?: Peer[];
}

export interface UiHandle {
  url: string;
  port: number;
  stop: () => Promise<void>;
}

// Bun's types call every .html import an HTMLBundle; `type: "text"` makes it a string at
// runtime, and `bun build --compile` embeds it.
const page = pageText as unknown as string;

const POLL_MS = 200;
// state.json is checked for a new mtime this often; a change pushes `event: state`.
const STATE_POLL_MS = 1_000;
const HEARTBEAT_MS = 15_000;

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
export const isLoopback = (host: string): boolean => LOOPBACK.has(host) || /^127\./.test(host);

const urlHost = (host: string): string => (host.includes(":") ? `[${host}]` : host);

// "host:port" or "[v6]:port" → the host part, lowercased.
const hostPart = (header: string): string => {
  const value = header.trim().toLowerCase();
  if (value.startsWith("[")) return value.slice(0, value.indexOf("]") + 1);
  const colon = value.lastIndexOf(":");
  return colon >= 0 ? value.slice(0, colon) : value;
};

const sameToken = (given: string | null, token: string): boolean => {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export const startUi = async (options: UiOptions): Promise<UiHandle> => {
  const ctx: RunsContext = { repo: options.repo };
  const allowedHosts = new Set([urlHost(options.host).toLowerCase(), "localhost"]);
  const streams = new Set<() => void>();

  const hostAllowed = (req: Request): boolean => {
    const host = req.headers.get("host");
    if (!host || !allowedHosts.has(hostPart(host))) return false;
    const origin = req.headers.get("origin");
    if (!origin) return true;
    try {
      return allowedHosts.has(hostPart(new URL(origin).host));
    } catch {
      return false;
    }
  };

  const events = (req: Request, run: RunRef): Response => {
    const tail = tailer(join(run.runDir, "events.jsonl"), resumeOffset(req.headers.get("last-event-id")));
    const encoder = new TextEncoder();
    let close = (): void => {};
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let open = true;
        const send = (chunk: string): void => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            close();
          }
        };
        const pump = (): void => {
          let lines;
          try {
            lines = tail.read();
          } catch {
            return;
          }
          for (const line of lines) {
            const data = redactLine(line.text, run.phi);
            // An unparsable line is dropped, but the id still advances past it.
            send(data === undefined ? `id: ${line.end}\n\n` : `id: ${line.end}\ndata: ${data}\n\n`);
          }
        };
        const poll = setInterval(pump, POLL_MS);
        const watch = stateWatcher(run);
        // No `id:` line: Last-Event-ID is an events.jsonl offset, and a view is not one.
        const pushState = (): void => {
          const view = watch();
          if (view) send(`event: state\ndata: ${JSON.stringify(view)}\n\n`);
        };
        const statePoll = setInterval(pushState, STATE_POLL_MS);
        const ping = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
        close = () => {
          if (!open) return;
          open = false;
          clearInterval(poll);
          clearInterval(statePoll);
          clearInterval(ping);
          streams.delete(close);
          try {
            controller.close();
          } catch {
            // Already closed by the client.
          }
        };
        streams.add(close);
        req.signal.addEventListener("abort", () => close());
        // Flush headers at once, even when there is nothing to send yet.
        send(": ok\n\n");
        pump();
      },
      cancel: () => close(),
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  };

  const api = (req: Request, url: URL): Response | Promise<Response> => {
    if (!hostAllowed(req)) return json({ error: "forbidden host" }, 403);
    if (!sameToken(req.headers.get("x-brewery-token") ?? url.searchParams.get("token"), options.token)) {
      return json({ error: "token required" }, 401);
    }
    const parts = url.pathname.split("/").filter(Boolean).slice(1).map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return "";
      }
    });
    if (parts[0] !== "runs") return json({ error: "not found" }, 404);
    if (parts.length === 1) {
      if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
      return json(listRuns(ctx));
    }
    const run = findRun(parts[1] ?? "", ctx);
    if (!run) {
      // A run whose state.json does not parse exists but is broken: its view says so.
      const bareGet = parts.length === 2 && req.method === "GET";
      if (bareGet && runUnreadable(parts[1] ?? "", ctx)) return json({ error: STATE_UNREADABLE }, 500);
      return json({ error: "no such run" }, 404);
    }
    const [, , sub, arg, extra] = parts;
    if (extra !== undefined) return json({ error: "not found" }, 404);
    if (sub === undefined && req.method === "GET") return viewRoute(req, run, {});
    if (sub === "events" && arg === undefined && req.method === "GET") return events(req, run);
    if (sub === "steps" && arg !== undefined && req.method === "GET") return stepRoute(req, run, { seq: arg });
    if ((sub === "answer" || sub === "note") && arg === undefined && req.method === "POST") return answerRoute(req, run, { action: sub });
    return json({ error: "not found" }, 404);
  };

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    // SSE streams stay open; the heartbeat keeps proxies from dropping them.
    idleTimeout: 0,
    // A route that throws gets a fixed JSON body, never Bun's page with source and stack.
    error: () => json({ error: "internal error" }, 500),
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/")) return api(req, url);
      if (url.pathname === "/" && req.method === "GET") {
        if (!hostAllowed(req)) return new Response("forbidden host", { status: 403 });
        return new Response(page, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const port = server.port ?? options.port;
  return {
    url: `http://${urlHost(options.host)}:${port}/?token=${encodeURIComponent(options.token)}`,
    port,
    stop: async () => {
      for (const close of [...streams]) close();
      await server.stop(true);
    },
  };
};
