import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredUiPeers } from "../src/config.ts";
import { checkPeers, parsePeer } from "../src/ui/peers.ts";

const SECRET = "peer-secret-do-not-echo";

const thrown = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a throw");
};

describe("--peer parsing", () => {
  test("name=url#token gives the peer, with a trailing slash trimmed", () => {
    expect(parsePeer(`zerg=http://100.64.0.2:4848/#${SECRET}`)).toEqual({ id: "zerg", url: "http://100.64.0.2:4848", token: SECRET });
  });

  test("a token may contain #", () => {
    expect(parsePeer("zerg=http://h:1#a#b").token).toBe("a#b");
  });

  test("a spec missing its token, url, or name is rejected without echoing the token", () => {
    for (const spec of ["zerg=http://h:1", `=http://h:1#${SECRET}`, `zerg=#${SECRET}`, `zerg=ftp://h#${SECRET}`, `zerg=not a url#${SECRET}`]) {
      const message = thrown(() => parsePeer(spec));
      expect(message).toContain("brewery ui");
      expect(message).not.toContain(SECRET);
    }
  });

  test("a peer cannot take the local or scan source name, or a name with ~", () => {
    for (const name of ["local", "scan", "a~b"]) expect(thrown(() => parsePeer(`${name}=http://h:1#${SECRET}`))).not.toContain(SECRET);
  });

  test("the same peer name twice is rejected", () => {
    const peer = { id: "zerg", url: "http://h:1", token: SECRET };
    expect(thrown(() => checkPeers([peer, { ...peer, url: "http://h:2" }]))).toContain("twice");
  });
});

describe("ui.peers in the user config", () => {
  let dir: string;
  let saved: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "brewery-peers-"));
    saved = process.env.BREWERY_CONFIG;
    process.env.BREWERY_CONFIG = join(dir, "config.json");
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BREWERY_CONFIG;
    else process.env.BREWERY_CONFIG = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  test("lists the peer specs and skips entries that are not strings", () => {
    writeFileSync(process.env.BREWERY_CONFIG as string, JSON.stringify({ ui: { peers: [`zerg=http://h:1#${SECRET}`, 3, ""] } }));
    expect(configuredUiPeers()).toEqual([`zerg=http://h:1#${SECRET}`]);
  });

  test("no config file means no peers", () => {
    expect(configuredUiPeers()).toEqual([]);
  });
});
