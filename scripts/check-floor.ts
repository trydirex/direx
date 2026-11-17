// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";

// Fails on a diff that lowers the bar in CONSTRAINTS.md: a new suppression, a stub, a skipped or
// deleted test, a removed assertion, a loosened rule or a new exception. Exit 0 clean, 1 violation,
// 2 could not run; a 2 never reads as clean. Base: --base, then DIREX_BASE, then origin/main.

const i = process.argv.indexOf("--base");
const base = i > 0 ? process.argv[i + 1]! : (process.env.DIREX_BASE ?? "origin/main");

// `git diff --no-index` exits 1 whenever the sides differ, the normal case for a new file.
const git = (args: string[], diffExit = false): string | null => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
  } catch (e) {
    const err = e as { status?: number; stdout?: unknown };
    return diffExit && err.status === 1 && typeof err.stdout === "string" ? err.stdout : null;
  }
};
const bail = (msg: string): never => {
  console.error(`floor-guard: ${msg}`);
  process.exit(2);
};

const top = git(["rev-parse", "--show-toplevel"])?.trim();
if (!top) bail("not inside a git work tree");
process.chdir(top!);

const mergeBase = git(["merge-base", base, "HEAD"])?.trim();
if (!mergeBase) bail(`no merge base against ${base}`);

const tracked = git(["diff", "--unified=0", mergeBase!, "--"]);
if (tracked === null) bail(`could not diff against ${mergeBase}`);
const untrackedFiles = git(["ls-files", "--others", "--exclude-standard"]);
if (untrackedFiles === null) bail("could not list untracked files");
const untracked = untrackedFiles!
  .split("\n")
  .filter(Boolean)
  .map((f) => {
    const d = git(["diff", "--no-index", "--unified=0", "/dev/null", f], true);
    return d ?? bail(`could not diff untracked file ${f}`);
  })
  .join("\n");

// `---` and `+++` are headers only between a file's `diff` line and its first hunk.
type Line = { file: string; text: string };
const added: Line[] = [];
const removed: Line[] = [];
const deleted: string[] = [];
const pathOf = (s: string) => s.replace(/^[ab]\//, "");
let file = "";
let oldFile = "";
let inHeader = false;
for (const line of `${tracked}\n${untracked}`.split("\n")) {
  if (line.startsWith("diff ")) inHeader = true;
  else if (line.startsWith("@@")) inHeader = false;
  else if (inHeader) {
    if (line.startsWith("--- ")) oldFile = pathOf(line.slice(4));
    else if (line.startsWith("+++ ")) {
      const newFile = pathOf(line.slice(4));
      file = newFile === "/dev/null" ? oldFile : newFile;
      if (newFile === "/dev/null") deleted.push(file);
    }
  } else if (line.startsWith("+")) added.push({ file, text: line.slice(1) });
  else if (line.startsWith("-")) removed.push({ file, text: line.slice(1) });
}

const findings: { rule: string; file: string; text: string }[] = [];
const flag = (rule: string, f: string, text: string) => findings.push({ rule, file: f, text: text.trim().slice(0, 120) });
const isTest = (f: string) => /\.(test|spec)\.tsx?$/.test(f);
const isConstraints = (f: string) => /(^|\/)CONSTRAINTS\.md$/.test(f);
// These patterns appear in this file and its test as data.
const isSource = (f: string) =>
  /\.(ts|tsx|js|mjs|cjs)$/.test(f) && !/^scripts\/(test\/)?check-floor(\.test)?\.ts$/.test(f) && !f.includes("/fixtures/");
const isException = (t: string) => /^\| *E\d+ *\|/.test(t.trim());

const SUPPRESSIONS = /@ts-ignore|@ts-nocheck|eslint-disable|istanbul ignore|c8 ignore|v8 ignore|nosemgrep|gitleaks:allow/;
const STUBS = /throw new (Error|NotImplemented).*[Nn]ot implemented|catch\s*(\(\w*\))?\s*\{\s*\}|\bTODO\b/;
const SKIPS = /\.(skip|todo|skipIf)\b|\bxit\(|\bxdescribe\(/;

for (const { file: f, text } of added) {
  if (isConstraints(f) && isException(text)) flag("new-exception", f, text);
  if (!isSource(f)) continue;
  if (SUPPRESSIONS.test(text)) flag("silenced-checker", f, text);
  // A type test proves a call does not compile; anywhere else this is a suppression.
  if (text.includes("@ts-expect-error") && !isTest(f)) flag("silenced-checker", f, text);
  if (STUBS.test(text)) flag("unfinished-work", f, text);
  if (SKIPS.test(text) && isTest(f)) flag("test-made-easier", f, text);
}

for (const f of deleted) if (isTest(f)) flag("test-deleted", f, "file deleted");

// Counted per file, so a rewritten assertion is not a removed one.
const ASSERTION = /\b(expect|assert)\b/;
const assertionCount = (lines: Line[], f: string) => lines.filter((l) => l.file === f && ASSERTION.test(l.text)).length;
for (const f of new Set(removed.map((l) => l.file))) {
  if (!isTest(f) || deleted.includes(f)) continue;
  const lost = assertionCount(removed, f) - assertionCount(added, f);
  if (lost > 0) flag("assertion-removed", f, `${lost} fewer assertion line(s)`);
}

// A rule is a floor bullet or a table row, named by the text before its first colon or its first
// cell. A minimum loosens going down and a maximum going up; a number whose direction cannot be
// read is reported on any change, because staying quiet is the wrong default.
const ruleKey = (t: string): string | null => {
  const s = t.trim();
  if (s.startsWith("|")) return s.split("|").map((c) => c.trim()).filter(Boolean)[0] ?? "";
  if (/^[-*] /.test(s)) return s.slice(2).split(":")[0]!.trim();
  return null;
};
const MIN_BEFORE = /(>=|>|≥|at least|minimum|\bmin\b|no less than|not fall|not drop)\s*$/;
const MAX_BEFORE = /(<=|<|≤|at most|maximum|\bmax\b|no more than|under|below|not grow|not exceed)\s*$/;
type Dir = "min" | "max" | null;
const thresholds = (t: string): { n: number; dir: Dir }[] =>
  [...t.matchAll(/\d+(?:\.\d+)?/g)].map((m) => {
    const before = t.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    const dir: Dir = MIN_BEFORE.test(before) ? "min" : MAX_BEFORE.test(before) ? "max" : null;
    return { n: Number(m[0]), dir };
  });

const rules = (lines: Line[]) => lines.filter((l) => isConstraints(l.file) && ruleKey(l.text) !== null);
const addedRules = rules(added);
for (const r of rules(removed)) {
  const a = addedRules.find((x) => ruleKey(x.text) === ruleKey(r.text));
  if (!a) {
    // Dropping an exception tightens the bar.
    if (!isException(r.text)) flag("rule-removed", r.file, r.text);
    continue;
  }
  const before = thresholds(r.text);
  const after = thresholds(a.text);
  const dirs: Dir[] = ["min", "max", null];
  const loosened = dirs.some((dir) => {
    const now = after.filter((x) => x.dir === dir);
    return before
      .filter((x) => x.dir === dir)
      .some((b, n) => {
        const c = now[n];
        if (!c) return true;
        return dir === "min" ? c.n < b.n : dir === "max" ? c.n > b.n : c.n !== b.n;
      });
  });
  if (loosened) flag("threshold-loosened", r.file, `${r.text}  ->  ${a.text}`);
}

if (findings.length === 0) {
  console.log("floor-guard: clean");
  process.exit(0);
}
console.error(`floor-guard: ${findings.length} floor violation(s):`);
for (const f of findings) console.error(`  [${f.rule}] ${f.file}: ${f.text}`);
console.error("\nEach lowers the bar. Fix the code; a person can approve an exception with the constraints-approved PR label.");
process.exit(1);
