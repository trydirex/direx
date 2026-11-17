// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// Reads the lcov the test run already wrote. Fails when project line coverage or coverage of the
// lines this branch changed drops below the bar. Exit 0 pass, 1 below the bar, 2 could not run.

const MIN_PERCENT = 80;

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const lcovPath = arg("--lcov") ?? "coverage/lcov.info";
const base = arg("--base") ?? process.env.DIREX_BASE ?? "origin/main";
const bail = (msg: string): never => {
  console.error(`coverage: ${msg}`);
  process.exit(2);
};
const git = (args: string[]): string | null => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
  } catch {
    return null;
  }
};

if (!existsSync(lcovPath)) bail(`${lcovPath} not found; run bun run test:coverage first`);

const hits = new Map<string, Map<number, number>>();
let current: Map<number, number> | undefined;
for (const line of readFileSync(lcovPath, "utf8").split("\n")) {
  if (line.startsWith("SF:")) hits.set(line.slice(3), (current = new Map()));
  else if (line.startsWith("DA:")) {
    const [n, count] = line.slice(3).split(",");
    current?.set(Number(n), Number(count));
  }
}

const percent = (covered: number, total: number) => (total === 0 ? 100 : (covered / total) * 100);
let total = 0;
let covered = 0;
for (const lines of hits.values()) {
  for (const count of lines.values()) {
    total++;
    if (count > 0) covered++;
  }
}
const project = percent(covered, total);

const mergeBase = git(["merge-base", base, "HEAD"])?.trim();
if (!mergeBase) bail(`no merge base against ${base}`);
const tracked = git(["diff", "--unified=0", mergeBase!, "--"]);
const others = git(["ls-files", "--others", "--exclude-standard"]);
if (tracked === null || others === null) bail("could not read the diff");

const changed = new Map<string, Set<number>>();
let file = "";
for (const line of tracked!.split("\n")) {
  if (line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "");
  const m = line.match(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/);
  if (!m) continue;
  const set = changed.get(file) ?? new Set<number>();
  const start = Number(m[1]);
  for (let n = 0; n < Number(m[2] ?? 1); n++) set.add(start + n);
  changed.set(file, set);
}

let changedTotal = 0;
let changedCovered = 0;
const missed: string[] = [];
const untracked = new Set(others!.split("\n").filter(Boolean));
for (const [f, lines] of hits) {
  const set = changed.get(f);
  const isNew = untracked.has(f);
  if (!set && !isNew) continue;
  let fileMissed = 0;
  for (const [n, count] of lines) {
    if (!isNew && !set!.has(n)) continue;
    changedTotal++;
    if (count > 0) changedCovered++;
    else fileMissed++;
  }
  if (fileMissed > 0) missed.push(`  ${f}: ${fileMissed} uncovered changed line(s)`);
}
const changedPercent = percent(changedCovered, changedTotal);

console.log(`coverage: project ${project.toFixed(2)}%, changed lines ${changedPercent.toFixed(2)}% (${changedCovered}/${changedTotal}), bar ${MIN_PERCENT}%`);
if (project >= MIN_PERCENT && changedPercent >= MIN_PERCENT) process.exit(0);
for (const m of missed) console.error(m);
process.exit(1);
