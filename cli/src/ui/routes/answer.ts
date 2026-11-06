// Answer a waiting run or add a note. T9 builds it.
// Until then the route exists and answers 501, so that task edits only this module.
import type { RunRef } from "../runs.ts";

export const answerRoute = (_req: Request, _run: RunRef, _params: Record<string, string>): Response =>
  Response.json({ error: "not implemented" }, { status: 501 });
