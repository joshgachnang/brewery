// Deterministic reads and writes of a distilled IP. brewery, not the agent, owns the
// Status line and the task checkboxes, so approval and progress cannot be faked.
import { readFileSync, writeFileSync } from "node:fs";

export interface IpTask {
  id: string;
  title: string;
  done: boolean;
  deps: string[];
  // From the task's `Files:` line. Undefined when the task declares none.
  files?: string[];
}

const TASK_LINE = /^- \[( |x|X)\] \*\*(T\d+)\*\*\s*[—–:-]\s*(.+)$/gm;
const STATUS_LINE = /^Status:[ \t]*(.*)$/m;

export const parseTasks = (text: string): IpTask[] => {
  const matches = [...text.matchAll(TASK_LINE)];
  return matches.map((m, index) => {
    const details = text.slice(m.index! + m[0].length, matches[index + 1]?.index).split(/\r?\n/);
    let dependency: string | undefined;
    let files: string[] | undefined;
    for (const line of details) {
      if (!line.trim()) continue;
      if (!/^[ \t]+\S/.test(line) || /^[ \t]*#/.test(line)) break;
      const dependsMatch = /^[ \t]+(?:-[ \t]+)?Depends on:[ \t]*(.*)$/i.exec(line);
      if (dependsMatch) dependency ??= dependsMatch[1].trim();
      const filesMatch = /^[ \t]+(?:-[ \t]+)?Files:[ \t]*(.*)$/i.exec(line);
      if (filesMatch) files ??= filesMatch[1].split(",").map((f) => f.replace(/`/g, "").trim()).filter(Boolean);
    }
    const deps = dependency === undefined
      ? (index === 0 ? [] : [matches[index - 1][2]])
      : /^none$/i.test(dependency) ? [] : dependency.split(/,|\band\b/i).map((id) => id.trim().toUpperCase()).filter(Boolean);
    return { id: m[2], title: m[3].trim(), done: m[1] !== " ", deps, ...(files?.length ? { files } : {}) };
  });
};

export const taskGraphProblems = (tasks: IpTask[]): string[] => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const problems: string[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) duplicates.add(task.id);
    seen.add(task.id);
  }
  for (const id of duplicates) problems.push(`Duplicate task id: ${id}`);
  for (const task of tasks) {
    for (const dep of task.deps) {
      if (!byId.has(dep)) problems.push(`${task.id} depends on unknown task ${dep}`);
      else if (dep === task.id) problems.push(`${task.id} depends on itself`);
    }
  }

  const visited = new Set<string>();
  const path: string[] = [];
  const active = new Map<string, number>();
  const visit = (id: string): void => {
    const cycleStart = active.get(id);
    if (cycleStart !== undefined) {
      problems.push(`Dependency cycle: ${[...path.slice(cycleStart), id].join(" → ")}`);
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    active.set(id, path.length);
    path.push(id);
    for (const dep of byId.get(id)!.deps) {
      if (dep !== id && byId.has(dep)) visit(dep);
    }
    path.pop();
    active.delete(id);
  };
  for (const task of tasks) visit(task.id);
  return problems;
};

export const readyTasks = (tasks: IpTask[], landed: Set<string>): IpTask[] =>
  tasks.filter((task) => !task.done && task.deps.every((dep) => landed.has(dep)));

// Two tasks that declare a shared file conflict when they land, so they never build at once.
export const sharesFiles = (a: IpTask, b: IpTask): boolean => {
  const mine = new Set((a.files ?? []).map((f) => f.toLowerCase()));
  return (b.files ?? []).some((f) => mine.has(f.toLowerCase()));
};

export const readStatus = (text: string): string | null => STATUS_LINE.exec(text)?.[1]?.trim() ?? null;

export const isApproved = (text: string): boolean => /^approved\b/i.test(readStatus(text) ?? "");

export const setStatus = (text: string, status: string): string => {
  if (STATUS_LINE.test(text)) return text.replace(STATUS_LINE, `Status: ${status}`);
  return `${text.trimEnd()}\n\n## Sign-off\n\nStatus: ${status}\n`;
};

export const markTask = (text: string, id: string): string =>
  text.replace(new RegExp(`^- \\[ \\] \\*\\*${id}\\*\\*`, "m"), `- [x] **${id}**`);

export const title = (text: string): string => /^# (.+)$/m.exec(text)?.[1]?.trim() ?? "Untitled plan";

// First prose paragraph after the H1: the orientation paragraph of the brief.
export const orientation = (text: string): string => {
  const afterTitle = text.split(/^# .+$/m)[1] ?? "";
  const para = afterTitle
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith("#") && !p.startsWith("|") && !p.startsWith(">") && !/^Status:/.test(p));
  return para?.replace(/\s+/g, " ") ?? "";
};

// The brief's `Elephant:` line: the likeliest unraised risk, or "none". Absent in older IPs.
export const elephant = (text: string): string | undefined => text.match(/^Elephant:[ \t]*(\S.*)$/m)?.[1].trim();

export const readIp = (path: string): string => readFileSync(path, "utf8");
export const writeIp = (path: string, text: string): void => writeFileSync(path, text);
