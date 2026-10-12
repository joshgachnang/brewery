// Best-effort redaction for CI log text before brewery keeps it. Regexes can't find names
// or free-text PHI, so repos that handle PHI also limit where learnings go (`learn` in
// .brewery.json); this catches the structured identifiers and secrets.
const RULES: [RegExp, string][] = [
  [/\x1b\[[0-9;]*[A-Za-z]/g, ""],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[token]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16})\b/g, "[token]"],
  [/(Bearer\s+)[\w.~+/-]+=*/gi, "$1[token]"],
  [/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*)\S+/gi, "$1[redacted]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)[^@/\s]+@/gi, "$1[redacted]@"],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]"],
  [/(?<![\w.])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w.])/g, "[phone]"],
  // Bare dates may be birth dates; ISO timestamps (date followed by T) are kept.
  [/\b\d{4}-\d{2}-\d{2}\b(?!T\d)/g, "[date]"],
  [/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "[date]"],
  [/(?<![\w.])\d{7,}(?![\w.])/g, "[id]"],
];

export const scrub = (text: string): string => RULES.reduce((out, [pattern, to]) => out.replace(pattern, to), text);

// Scrub, then keep the last `max` characters, starting on a line boundary.
export const scrubTail = (text: string, max = 4096): string => {
  const clean = scrub(text).trimEnd();
  if (clean.length <= max) return clean;
  const tail = clean.slice(-max);
  const newline = tail.indexOf("\n");
  return newline >= 0 && newline < tail.length - 1 ? tail.slice(newline + 1) : tail;
};
