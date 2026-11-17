// SPDX-License-Identifier: AGPL-3.0-only
// Doctor's output and setup's .env rewrite. The real test of setup is scripts/check-first-run.ts,
// because a mock Docker would prove nothing.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { checks, runChecks, type Check } from "../scripts/doctor";
import { isLocalHost, nodeOk, parseEnv, withPostgresPort } from "../scripts/first-run";

const pass = (name: string, gate = false): Check => ({ name, run: () => true, fix: () => "x", gate });
const fail = (name: string, gate = false): Check => ({ name, run: () => false, fix: () => `fix ${name}`, gate });

test("doctor prints ok or FAIL with its fix, and exits 1 on any FAIL", async () => {
  const lines: string[] = [];
  expect(await runChecks([pass("a"), fail("b"), pass("c")], (l) => lines.push(l))).toBe(1);
  expect(lines).toEqual(["ok a", "FAIL b: fix b", "ok c"]);
  expect(await runChecks([pass("a")], () => {})).toBe(0);
});

test("a failed gate ends the report, because the rest can't run", async () => {
  const lines: string[] = [];
  await runChecks([fail("deps", true), pass("database")], (l) => lines.push(l));
  expect(lines).toEqual(["FAIL deps: fix deps"]);
});

test("every check carries a fix", async () => {
  const list = checks({ DIREX_DB_OWNER_URL: "postgres://o:p@localhost:5435/direx", DIREX_DB_APP_URL: "postgres://a:p@localhost:5435/direx" });
  expect(list.length).toBeGreaterThan(10);
  for (const c of list) expect(await c.fix(), c.name).toBeTruthy();
});

test("doctor loads pg only after the dependency check, so a fresh clone gets a report", () => {
  const source = readFileSync(new URL("../scripts/doctor.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/^import .* from "pg"/m);
  expect(source).not.toMatch(/^import .*apps\/api/m);
  const setup = readFileSync(new URL("../scripts/setup.ts", import.meta.url), "utf8");
  const imported = [...setup.matchAll(/^import .* from "(.*)";$/gm)].map((m) => m[1]!);
  expect(imported.length).toBeGreaterThan(0);
  for (const from of imported) expect(from).toMatch(/^(node:|\.\/first-run$)/);
});

test.each([
  ["", true],
  ["v19.6.0", false],
  ["v20.18.3", false],
  ["v20.19.0", true],
  ["v21.7.3", false],
  ["v22.11.0", false],
  ["v22.12.0", true],
  ["v23.6.1", true],
  ["v24.21.0", true],
])("Node %s is %s", (version, ok) => {
  expect(nodeOk(version)).toBe(ok);
});

const EXAMPLE = `# comment\nDIREX_DB_OWNER_URL=postgres://direx_owner:pw@localhost:5435/direx\nDIREX_DB_APP_URL=postgres://direx_app:pw@localhost:5435/direx\n# DIREX_BASE_URL\n`;

test("a port goes into the two URLs and DIREX_PG_PORT, and nothing else changes", () => {
  const out = withPostgresPort(`${EXAMPLE}DIREX_DB_POOL_URL=postgres://direx_app:pw@localhost:6435/direx\n`, "5999");
  expect(parseEnv(out)).toEqual({
    DIREX_DB_OWNER_URL: "postgres://direx_owner:pw@localhost:5999/direx",
    DIREX_DB_APP_URL: "postgres://direx_app:pw@localhost:5999/direx",
    DIREX_DB_POOL_URL: "postgres://direx_app:pw@localhost:6435/direx",
    DIREX_PG_PORT: "5999",
  });
  expect(out).toContain("# comment");
  expect(out).toContain("# DIREX_BASE_URL");
});

test("rewriting a port is repeatable, and replaces an earlier one", () => {
  const once = withPostgresPort(EXAMPLE, "5999");
  expect(withPostgresPort(once, "5999")).toBe(once);
  const moved = withPostgresPort(once, "6001");
  expect(moved.match(/DIREX_PG_PORT=/g)).toHaveLength(1);
  expect(parseEnv(moved).DIREX_PG_PORT).toBe("6001");
  expect(moved).not.toContain("5999");
});

test("the setup skill resolves through .claude, and keeps its stops and no internal references", () => {
  const skill = readFileSync(new URL("../.claude/skills/direx-setup/SKILL.md", import.meta.url), "utf8");
  for (const stop of ["Never create their sign-in", "Don't read them", "Never ask for, read or type a key", "Never approve anything"]) expect(skill).toContain(stop);
  const public_ = [skill, ...["README.md", "AGENTS.md"].map((f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8"))];
  for (const text of public_) expect(text).not.toMatch(/thoughts\/|\bADR\b|DX-R-|—|–/);
});

test("only a local database counts as ours to change", () => {
  expect(isLocalHost("postgres://o:p@localhost:5435/d")).toBe(true);
  expect(isLocalHost("postgres://o:p@127.0.0.1:5435/d")).toBe(true);
  expect(isLocalHost("postgres://o:p@db.example.com:5435/d")).toBe(false);
});
