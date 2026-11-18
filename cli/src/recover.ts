// What brewery does before it starts or resumes work, and as work lands: stop what an earlier,
// dead brewery left running, then reclaim what it left on disk. Order matters. The disk sweep
// skips any directory a live process names, so an orphaned database server would protect its own leak.
import { installShutdownCleanup } from "./agents.ts";
import { reapLine, reapOrphans } from "./reap.ts";
import { sweepLeftovers, sweepLine } from "./scratch.ts";
import { runDir, type RunState } from "./state.ts";

export const recoverEnvironment = async (state: RunState, log: (line: string) => void): Promise<void> => {
  const dir = runDir(state.repo, state.slug);
  installShutdownCleanup(dir);
  const reaped = reapLine(await reapOrphans(dir));
  if (reaped) log(reaped);
  const swept = sweepLine(await sweepLeftovers());
  if (swept) log(swept);
};

// Between tasks: only the disk, because nothing of an earlier brewery can have appeared since the start.
export const sweepBetweenTasks = async (log: (line: string) => void): Promise<void> => {
  const swept = sweepLine(await sweepLeftovers());
  if (swept) log(swept);
};
