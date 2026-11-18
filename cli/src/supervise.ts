// Runs a long command (barrel, resume, finish) as a child and starts it again when it dies the
// way a healthy run does not: a Bun panic (SIGABRT, exit 134), an OOM kill (SIGKILL, 137), a
// segfault. A brewery run is resumable by design (state.json, tasks go back to todo), so the
// cheapest recovery is the same command again, after the survivors are stopped. A normal exit,
// an error brewery reported itself, or a gate for the human ends supervision: looping on those
// would hide a real fault or answer a question the human has not seen.
import { sweepLeftovers, sweepLine } from "./scratch.ts";

// Wait statuses of a process that crashed rather than exited: 128 + SIGILL, SIGABRT, SIGBUS,
// SIGFPE, SIGKILL, SIGSEGV.
const CRASH_EXIT = new Set([132, 134, 135, 136, 137, 139]);
const CRASH_SIGNALS = new Set(["SIGILL", "SIGABRT", "SIGBUS", "SIGFPE", "SIGKILL", "SIGSEGV"]);

export interface Exit {
  code: number | null;
  signal: string | null;
}

export const isCrash = (exit: Exit): boolean => (exit.signal !== null && CRASH_SIGNALS.has(exit.signal)) || (exit.code !== null && CRASH_EXIT.has(exit.code));

export const describeExit = (exit: Exit): string => (exit.signal ? `signal ${exit.signal}` : `exit ${exit.code}`);

export const superviseEnvOff = (env: NodeJS.ProcessEnv = process.env): boolean => env.BREWERY_SUPERVISED === "1" || env.BREWERY_SUPERVISE === "0";

export interface SuperviseOptions {
  maxRestarts: number;
  run: () => Promise<Exit>;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  sweep?: () => Promise<string | null>;
}

// Returns the exit code brewery should exit with.
export const supervise = async (opts: SuperviseOptions): Promise<number> => {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const sweep = opts.sweep ?? (async () => sweepLine(await sweepLeftovers()));
  for (let restarts = 0; ; restarts++) {
    const exit = await opts.run();
    if (!isCrash(exit)) return exit.code ?? 1;
    if (restarts >= opts.maxRestarts) {
      opts.log(`brewery: crashed (${describeExit(exit)}) ${restarts + 1} times; giving up. Resume with the same command once the cause is fixed.`);
      return exit.code ?? 1;
    }
    opts.log(`brewery: crashed (${describeExit(exit)}); resuming (restart ${restarts + 1} of ${opts.maxRestarts})`);
    // The next brewery stops this run's leftover agents itself; the disk is the supervisor's.
    const swept = await sweep();
    if (swept) opts.log(swept);
    await sleep(Math.min(5_000 * (restarts + 1), 30_000));
  }
};

export const spawnSelf = async (argv: string[]): Promise<Exit> => {
  const proc = Bun.spawn([process.execPath, ...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, BREWERY_SUPERVISED: "1" } });
  const forward = (signal: NodeJS.Signals) => () => proc.kill(signal);
  const handlers = (["SIGTERM", "SIGINT", "SIGHUP"] as const).map((signal) => [signal, forward(signal)] as const);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const code = await proc.exited;
  for (const [signal, handler] of handlers) process.off(signal, handler);
  return { code: proc.signalCode ? null : code, signal: proc.signalCode ?? null };
};
