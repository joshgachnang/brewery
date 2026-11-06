import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newState, type RunState } from "../src/state.ts";
import { startUi } from "../src/ui/server.ts";
import { tempRepo } from "./helpers.ts";

const TOKEN = "page-test-token";
const PAGE_PATH = join(import.meta.dir, "..", "src", "ui", "page.html");
const SERVER_PATH = join(import.meta.dir, "..", "src", "ui", "server.ts");
const SLUG = "page-run";

let ui: { port: number; stop: () => void | Promise<void> } | undefined;
let repo = "";
let indexPath = "";
let savedIndex: string | undefined;

const page = (): string => readFileSync(PAGE_PATH, "utf8");

beforeEach(async () => {
  savedIndex = process.env.BREWERY_INDEX;
  repo = tempRepo();
  indexPath = join(repo, "index.json");
  process.env.BREWERY_INDEX = indexPath;
  const dir = join(repo, ".terreno", "brewery", SLUG);
  mkdirSync(dir, { recursive: true });
  const state: RunState = newState({ slug: SLUG, repo, ip: `docs/plans/${SLUG}.md`, base: "master", phase: "build" });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  writeFileSync(join(dir, "events.jsonl"), "");
  ui = (await startUi({ repo, port: 0, host: "127.0.0.1", token: TOKEN })) as typeof ui;
});

afterEach(async () => {
  await ui?.stop();
  ui = undefined;
  if (savedIndex === undefined) delete process.env.BREWERY_INDEX;
  else process.env.BREWERY_INDEX = savedIndex;
  rmSync(repo, { recursive: true, force: true });
});

const base = (): string => `http://127.0.0.1:${ui?.port}`;

describe("GET /", () => {
  test("serves the page as text/html without a token", async () => {
    const res = await fetch(`${base()}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toBe(page());
    // The page carries no data: no run slug appears in it.
    expect(body).not.toContain(SLUG);
  });
});

describe("page source: token handling", () => {
  test("strips token from the address bar with history.replaceState", () => {
    const html = page();
    const drop = html.indexOf('params.delete("token")');
    expect(drop).toBeGreaterThan(-1);
    expect(html.indexOf("history.replaceState(", drop)).toBeGreaterThan(drop);
  });

  test("sends the token only as the X-Brewery-Token header, never in an API URL", () => {
    const html = page();
    expect(html).toContain("X-Brewery-Token");
    expect(html).not.toMatch(/\/api\/[^"'`\s]*[?&]token=/);
    expect(html).not.toMatch(/searchParams\.(set|append)\(\s*["']token/);
    expect(html).not.toMatch(/URLSearchParams\(\s*\{\s*token/);
    // Every request carries the header.
    const fetches = html.match(/fetch\([^;]*/g) ?? [];
    expect(fetches.length).toBeGreaterThan(0);
    for (const call of fetches) expect(call).toContain("headers(");
  });
});

describe("page source: self-contained", () => {
  test("loads no script or stylesheet over http(s)", () => {
    const html = page();
    expect(html).not.toMatch(/<script[^>]*\ssrc\s*=\s*["']?https?:/i);
    expect(html).not.toMatch(/<link[^>]*href\s*=\s*["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/@import\s+(url\()?\s*["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/<script[^>]*\ssrc=/i);
  });

  test("has a viewport meta and a prefers-color-scheme block", () => {
    const html = page();
    expect(html).toMatch(/<meta\s+name="viewport"/);
    expect(html).toContain("prefers-color-scheme");
  });

  test("server.ts imports page.html as text so bun build --compile embeds it", () => {
    expect(readFileSync(SERVER_PATH, "utf8")).toMatch(/import\s+\w+\s+from\s+["']\.\/page\.html["']\s+with\s*\{\s*type:\s*["']text["']\s*\}/);
  });
});

describe("page source: API calls match the server's route table", () => {
  const paths = (): string[] => {
    const found = page().match(/\/api\/[^"'`\s?\\)]*/g) ?? [];
    return [...new Set(found.map((p) => p.replace(/\/+$/, "")))];
  };

  test("calls every route the interface names", () => {
    const html = page();
    expect(html).toMatch(/\/api\/runs\b/);
    for (const tail of ["/events", "/steps/", "/answer", "/note"]) expect(html).toContain(tail);
  });

  test("calls no path the server does not register", async () => {
    const calls = paths();
    expect(calls.length).toBeGreaterThanOrEqual(5);
    const runId = `local~${SLUG}`;
    // The fixture run must resolve, or every sub-route would answer "no such run".
    const view = await fetch(`${base()}/api/runs/${encodeURIComponent(runId)}`, { headers: { "X-Brewery-Token": TOKEN } });
    expect(view.status).toBe(200);
    for (const call of calls) {
      const segments = call.split("/").filter(Boolean).slice(1); // drop "api"
      const resolved = segments.map((segment, i) => {
        if (!segment.includes("${")) return segment;
        return segments[i - 1] === "steps" ? "1" : encodeURIComponent(runId);
      });
      const path = `/api/${resolved.join("/")}`;
      const post = /\/(answer|note)$/.test(path);
      const controller = new AbortController();
      const res = await fetch(`${base()}${path}`, {
        method: post ? "POST" : "GET",
        headers: { "X-Brewery-Token": TOKEN, ...(post ? { "content-type": "application/json" } : {}) },
        body: post ? JSON.stringify({ text: "x" }) : undefined,
        signal: controller.signal,
      });
      const isStream = path.endsWith("/events");
      const body = isStream ? "" : await res.text();
      controller.abort();
      // A dead call gets the router's fixed "not found" body.
      expect(`${path} ${body}`).not.toContain('"error":"not found"');
      expect(`${path} ${body}`).not.toContain('"error":"no such run"');
      if (isStream) expect(res.status).toBe(200);
    }
  });

  test("builds every API path in one literal, never by concatenation", () => {
    // A path ending in "/" before `" +` would hide its tail from the route check above.
    expect(page()).not.toMatch(/["'`]\/api\/[^"'`]*\/["'`]\s*\+/);
  });

  test("sends answer and note as POST", () => {
    const html = page();
    const postCall = html.match(/fetch\(path,[^;]*/)?.[0] ?? "";
    expect(html).toMatch(/\/api\/runs\/\$\{rid\}\/answer[^;]*\/api\/runs\/\$\{rid\}\/note/);
    expect(postCall).toContain('method: "POST"');
  });
});

describe("page source: dashboard content", () => {
  test("lists runs grouped by source with a 'needs you' badge and a live dot", () => {
    const html = page().toLowerCase();
    expect(html).toContain("needs you");
    expect(html).toMatch(/\.live|live-dot|data-live/);
    expect(html).toContain("source");
  });

  test("draws the pipeline strip with all five stages", () => {
    const html = page().toLowerCase();
    for (const stage of ["distill", "cut", "sign-off", "barrel", "finish"]) expect(html).toContain(stage);
  });

  test("has a waiting banner with an answer box that handles 409 commands and PHI runs", () => {
    const html = page();
    expect(html).toContain("409");
    expect(html).toContain("command");
    expect(html).toMatch(/questions? waiting/i);
    expect(html).toContain("Read them at the terminal or in the IP");
  });

  test("has task lanes with test, pick, and roast cards", () => {
    const html = page().toLowerCase();
    for (const kind of ["test", "pick", "roast"]) expect(html).toContain(kind);
    expect(html).toMatch(/lane/);
  });

  test("has an Active agents grid", () => {
    expect(page()).toContain("Active agents");
  });

  test("has a routes table marked run or config, and totals for time, tokens, and cost", () => {
    const html = page().toLowerCase();
    expect(html).toContain("routes");
    expect(html).toContain("config");
    for (const total of ["tokens", "cost"]) expect(html).toContain(total);
  });

  test("opens a drawer with the step detail when a card is clicked", () => {
    const html = page().toLowerCase();
    expect(html).toContain("drawer");
    expect(html).toContain("/steps/");
  });

  test("links cards through handoffs", () => {
    expect(page().toLowerCase()).toContain("handoff");
  });

  test("reconnects the event stream with Last-Event-ID", () => {
    expect(page().toLowerCase()).toContain("last-event-id");
  });
});
