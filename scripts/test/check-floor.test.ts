// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";

const script = (name: string) => join(import.meta.dirname, "..", name);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "direx-floor-"));
  dirs.push(dir);
  const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir });
  const write = (fs: Record<string, string>) => {
    for (const [f, text] of Object.entries(fs)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), text);
    }
  };
  git("init", "-q");
  write(files);
  git("add", ".");
  git("commit", "-qm", "base");
  git("branch", "base");
  return { dir, write, git };
}

const run = (name: string, dir: string, ...args: string[]) => {
  const r = Bun.spawnSync([process.execPath, script(name), ...args], { cwd: dir, env: { ...process.env, DIREX_BASE: "base" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

const TEST = 'test("x", () => {\n  expect(1).toBe(1);\n});\n';
const RULES = "| Coverage | changed lines >= 80% |\n";

test("a clean diff passes", () => {
  const { dir, write } = repo({ "a.ts": "export const a = 1;\n" });
  write({ "a.ts": "export const a = 2;\n" });
  expect(run("check-floor.ts", dir)).toMatchObject({ code: 0 });
});

test.each([
  ["a new suppression", { "a.ts": "// @ts-ignore\n" }, "silenced-checker"],
  ["an expected type error outside a test", { "a.ts": "// @ts-expect-error nope\n" }, "silenced-checker"],
  ["an empty catch", { "a.ts": "try { f(); } catch {}\n" }, "unfinished-work"],
  ["a skipped test", { "a.test.ts": `${TEST}test.skip("y", () => {});\n` }, "test-made-easier"],
  ["a removed assertion", { "a.test.ts": 'test("x", () => {\n});\n' }, "assertion-removed"],
  ["a loosened threshold", { "CONSTRAINTS.md": "| Coverage | changed lines >= 70% |\n" }, "threshold-loosened"],
  ["a removed rule", { "CONSTRAINTS.md": "\n" }, "rule-removed"],
  ["a new exception", { "CONSTRAINTS.md": `${RULES}| E1 | rule | path | why | me | 2027-01-01 |\n` }, "new-exception"],
])("%s fails", (_name, change, rule) => {
  const { dir, write } = repo({ "a.ts": "export const a = 1;\n", "a.test.ts": TEST, "CONSTRAINTS.md": RULES });
  write(change);
  const r = run("check-floor.ts", dir);
  expect(r.code).toBe(1);
  expect(r.out).toContain(`[${rule}]`);
});

test("a deleted test fails", () => {
  const { dir, git } = repo({ "a.test.ts": TEST });
  git("rm", "-q", "a.test.ts");
  expect(run("check-floor.ts", dir).out).toContain("[test-deleted]");
});

test("tightening a threshold, rewriting an assertion and a type test pass", () => {
  const { dir, write } = repo({ "a.test.ts": TEST, "CONSTRAINTS.md": RULES });
  write({
    "CONSTRAINTS.md": "| Coverage | changed lines >= 90% |\n",
    "a.test.ts": 'test("x", () => {\n  // @ts-expect-error callers cannot do this\n  expect(2).toBe(2);\n});\n',
  });
  expect(run("check-floor.ts", dir)).toMatchObject({ code: 0 });
});

test("no merge base is exit 2, not a pass", () => {
  const { dir } = repo({ "a.ts": "\n" });
  expect(run("check-floor.ts", dir, "--base", "missing").code).toBe(2);
});

const LCOV = (lines: string) => `SF:a.ts\n${lines}end_of_record\n`;

test("coverage fails on uncovered changed lines and passes when they are covered", () => {
  const { dir, write } = repo({ "a.ts": "1\n2\n3\n4\n5\n", "lcov.info": LCOV("DA:1,1\nDA:2,1\nDA:3,1\nDA:4,1\nDA:5,1\n") });
  write({ "a.ts": "1\n2\n3\n4\nchanged\n", "lcov.info": LCOV("DA:1,1\nDA:2,1\nDA:3,1\nDA:4,1\nDA:5,0\n") });
  const low = run("check-coverage.ts", dir, "--lcov", "lcov.info");
  expect(low.code).toBe(1);
  expect(low.out).toContain("a.ts: 1 uncovered changed line(s)");
  write({ "lcov.info": LCOV("DA:1,1\nDA:2,1\nDA:3,1\nDA:4,1\nDA:5,1\n") });
  expect(run("check-coverage.ts", dir, "--lcov", "lcov.info").code).toBe(0);
});

test("coverage fails when the project is under the bar even if no line changed", () => {
  const { dir, write } = repo({ "a.ts": "1\n" });
  write({ "lcov.info": LCOV("DA:1,0\nDA:2,1\n") });
  expect(run("check-coverage.ts", dir, "--lcov", "lcov.info").code).toBe(1);
});

test("coverage without a report or a merge base is exit 2", () => {
  const { dir, write } = repo({ "a.ts": "1\n" });
  expect(run("check-coverage.ts", dir).code).toBe(2);
  write({ "lcov.info": LCOV("DA:1,1\n") });
  expect(run("check-coverage.ts", dir, "--lcov", "lcov.info", "--base", "missing").code).toBe(2);
});
