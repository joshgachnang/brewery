// `brewery ui [--port N] [--host H] [--repo PATH]`: serve the dashboard until killed.
import { isLoopback, startUi } from "../ui/server.ts";
import { repoRoot } from "../vcs.ts";

export const DEFAULT_UI_PORT = 4848;
export const DEFAULT_UI_HOST = "127.0.0.1";

export interface UiFlags {
  port?: string;
  host?: string;
  repo?: string;
}

export const ui = async (flags: UiFlags, log: (line: string) => void): Promise<number> => {
  const port = flags.port === undefined ? DEFAULT_UI_PORT : Number(flags.port);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("brewery ui: --port needs a port number (0–65535)");
  // Only an explicit --host binds beyond loopback; there is no env or config fallback.
  const host = flags.host ?? DEFAULT_UI_HOST;
  const cwd = flags.repo ?? process.cwd();
  const repo = await repoRoot(cwd).catch(() => cwd);
  const token = process.env.BREWERY_UI_TOKEN || crypto.randomUUID();
  const handle = await startUi({ repo, port, host, token });
  if (!isLoopback(host)) log(`brewery ui: listening on ${host}, beyond this machine. Share the URL only with yourself.`);
  log(handle.url);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void handle.stop().finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
};
