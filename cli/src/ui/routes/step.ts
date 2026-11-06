// One step's detail (prompt, result, handoffs, log tail). T7 builds it.
// Until then the route exists and answers 501, so that task edits only this module.
import type { RunRef } from "../runs.ts";

export const stepRoute = (_req: Request, _run: RunRef, _params: Record<string, string>): Response =>
  Response.json({ error: "not implemented" }, { status: 501 });
