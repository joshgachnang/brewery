#!/usr/bin/env bun
// Lints a screenshot flow for the rules that keep it working on every device size.
// Usage: bun check.ts <flow.yaml>. Exit 0 clean, 2 problems found.
import { existsSync, readFileSync } from "node:fs";

export interface FlowCheck {
  shots: string[];
  problems: string[];
  warnings: string[];
}

const SHOT_NAME = /^\d{2}-[a-z0-9-]+$/;

export const checkFlow = (text: string): FlowCheck => {
  const [header, ...rest] = text.split(/^---\s*$/m);
  const body = rest.join("---");
  const shots: string[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  if (rest.length === 0) problems.push("no `---` between the header and the commands");
  if (!/^appId:\s*\$\{APP_ID\}\s*$/m.test(header)) problems.push("the header must be `appId: ${APP_ID}`, because iOS and Android ids differ");

  let previousCommand = "";
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const topLevel = line.match(/^- ([A-Za-z]+)/);
    const shot = line.match(/^(\s*)- takeScreenshot:\s*(.*)$/);
    if (shot) {
      const name = shot[2].trim().replace(/^["']|["']$/g, "");
      if (shot[1] !== "") problems.push(`takeScreenshot ${name || "(full form)"} is nested; every shot runs on every device, so fork navigation in a subflow and keep the shot top-level`);
      else if (!name) problems.push("use the `- takeScreenshot: NN-name` shorthand");
      else {
        if (!SHOT_NAME.test(name)) problems.push(`shot name ${name} must look like 01-home`);
        if (shots.includes(name)) problems.push(`shot name ${name} is used twice`);
        if (shots.length > 0 && name < shots[shots.length - 1]) problems.push(`shot ${name} is out of order after ${shots[shots.length - 1]}`);
        if (previousCommand !== "waitForAnimationToEnd") problems.push(`shot ${name} must directly follow waitForAnimationToEnd`);
        shots.push(name);
      }
    }
    if (/^\s*-?\s*point:/.test(line)) problems.push(`coordinates differ on every size, select by id: ${line.trim()}`);
    if (/^\s*-?\s*inputText:.*@/.test(line)) problems.push(`hard-coded account in the flow, pass it with \${EMAIL}: ${line.trim()}`);
    if (/^\s*-?\s*(sleep|wait):/.test(line)) problems.push(`no fixed waits, use extendedWaitUntil on a content testID: ${line.trim()}`);
    if (/^\s*- tapOn:\s*["'\w]/.test(line) && !line.includes("${")) warnings.push(`text selector breaks when copy or locale changes, prefer id: ${line.trim()}`);
    if (topLevel) previousCommand = topLevel[1];
  }
  if (shots.length === 0) problems.push("the flow takes no screenshots");
  return { shots, problems, warnings };
};

if (import.meta.main) {
  const path = process.argv[2];
  if (!path || !existsSync(path)) {
    console.error(`usage: check.ts <flow.yaml>${path ? ` (no such file: ${path})` : ""}`);
    process.exit(2);
  }
  const { shots, problems, warnings } = checkFlow(readFileSync(path, "utf8"));
  for (const warning of warnings) console.log(`warning: ${warning}`);
  for (const problem of problems) console.log(`problem: ${problem}`);
  console.log(`${shots.length} shots: ${shots.join(", ")}`);
  process.exit(problems.length > 0 ? 2 : 0);
}
