// Byte-offset tailer for `events.jsonl`. Polls with fstat/read rather than fs.watch, which
// misses appends under gVisor and on macOS. Only complete lines are returned; a trailing
// partial line stays unread until its newline arrives.
import { closeSync, openSync, readSync, statSync } from "node:fs";

export interface TailLine {
  // Byte offset just after this line's newline: the SSE id a reader resumes from.
  end: number;
  text: string;
}

export interface Tailer {
  offset: () => number;
  read: () => TailLine[];
}

const NEWLINE = 0x0a;

export const tailer = (path: string, from = 0): Tailer => {
  let offset = from;
  const read = (): TailLine[] => {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return []; // Not created yet.
    }
    if (size < offset) offset = 0; // Truncated or replaced: start over.
    if (size === offset) return [];
    const buf = Buffer.alloc(size - offset);
    let got = 0;
    try {
      const fd = openSync(path, "r");
      try {
        while (got < buf.length) {
          const n = readSync(fd, buf, got, buf.length - got, offset + got);
          if (n === 0) break;
          got += n;
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      return []; // Unreadable, a directory, or replaced mid-read: try again on the next poll.
    }
    const lines: TailLine[] = [];
    let start = 0;
    for (let i = 0; i < got; i++) {
      if (buf[i] !== NEWLINE) continue;
      lines.push({ end: offset + i + 1, text: buf.subarray(start, i).toString("utf8") });
      start = i + 1;
    }
    offset += start;
    return lines;
  };
  return { offset: () => offset, read };
};

// A Last-Event-ID resumes there only when it is a whole byte offset; anything else starts at 0.
export const resumeOffset = (header: string | null): number => {
  if (!header || !/^\d+$/.test(header.trim())) return 0;
  const n = Number(header.trim());
  return Number.isSafeInteger(n) ? n : 0;
};
