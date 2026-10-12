import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { newState, runDir, withRunLock } from "../../src/state.ts";

const [repo, id] = process.argv.slice(2);
const state = newState({ slug: "race", repo, ip: "", base: "master", phase: "build" });
const dir = runDir(repo, state.slug);
const original = fs.readFileSync;
// Hold contenders after they read the stale PID, at the actual filesystem boundary.
spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, ...args: any[]) => {
  const value = (original as any)(path, ...args);
  if (String(path) === join(dir, "run.pid") && String(value).trim() === "2147483647") {
    fs.writeFileSync(join(dir, `observed-${id}`), "ready");
    while (!fs.existsSync(join(dir, `release-reader-${id}`))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return value;
}) as typeof fs.readFileSync);
fs.writeFileSync(join(dir, `ready-${id}`), "ready");
while (!fs.existsSync(join(dir, "start"))) await Bun.sleep(5);
try {
  await withRunLock(state, async () => {
    fs.writeFileSync(join(dir, `entered-${id}`), "entered");
    while (!fs.existsSync(join(dir, "release-owner"))) await Bun.sleep(5);
  });
} catch (error) {
  if (!String(error).includes("already running")) throw error;
  fs.writeFileSync(join(dir, `rejected-${id}`), "rejected");
}
