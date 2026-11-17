// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const eslint = new ESLint({
  cwd: fileURLToPath(new URL("fixtures/lint", import.meta.url)),
  overrideConfigFile: `${root}eslint.config.js`,
  ignore: false,
});

const lintText = async (code: string, filePath: string) => (await eslint.lintText(code, { filePath }))[0]!;
const lintFile = async (path: string) => (await eslint.lintFiles([path]))[0]!;
const lines = (n: number) => `// SPDX-License-Identifier: AGPL-3.0-only\n${"export {};\n".repeat(n - 1)}`;

test("a 1,501-line file fails lint", async () => {
  const r = await lintText(lines(1501), "apps/api/src/big.ts");
  expect(r.errorCount).toBe(1);
  expect(r.messages.find((m) => m.severity === 2)?.message).toMatch(/^file-too-long/);
});

test("an 801-line file warns without failing", async () => {
  const r = await lintText(lines(801), "apps/api/src/long.ts");
  expect(r.errorCount).toBe(0);
  expect(r.warningCount).toBe(1);
  expect(r.messages[0]!.message).toMatch(/^file-too-long/);
});

test("generated files are exempt from max-lines", async () => {
  const r = await lintText(lines(1501), "apps/web/src/api/schema.ts");
  expect(r.messages).toEqual([]);
});

test("a raw pg import outside adapters/ fails lint", async () => {
  const r = await lintFile("apps/api/src/modules/x/application/raw-pg.ts");
  expect(r.errorCount).toBe(1);
  expect(r.messages[0]!.message).toMatch(/^raw-db-import/);
});

test("a raw driver import inside adapters/ is clean", async () => {
  expect((await lintFile("apps/api/src/modules/x/adapters/repo.ts")).messages).toEqual([]);
});

test("a relative vi.mock or vi.doMock fails lint", async () => {
  const r = await lintFile("apps/api/src/modules/x/x.test.ts");
  expect(r.messages.map((m) => [m.line, m.severity, m.message.slice(0, 16)])).toEqual([
    [4, 2, "relative-vi-mock"],
    [5, 2, "relative-vi-mock"],
  ]);
});

test("matching a pattern over an error message in core fails lint; showing it or a test doing it does not", async () => {
  const code = `// SPDX-License-Identifier: AGPL-3.0-only
export const a = (e: Error) => /answered (\\d{3})/.exec(e.message);
export const b = (e: Error) => e.message.match(/: ([a-z_]+)$/);
export const c = (e: Error) => e.message.replace(/^plugin error: /, "");
`;
  const r = await lintText(code, "apps/api/src/modules/x/application/read.ts");
  expect(r.messages.map((m) => [m.line, m.severity, m.message.slice(0, 29)])).toEqual([
    [2, 2, "read a failure's typed fields"],
    [3, 2, "read a failure's typed fields"],
  ]);
  expect((await lintText(code, "apps/api/src/modules/x/read.test.ts")).errorCount).toBe(0);
});

test("casting a plugin's spec, answer or event data to an object type in core fails lint; other casts do not", async () => {
  const code = `// SPDX-License-Identifier: AGPL-3.0-only
declare const row: { spec: unknown; payload: unknown; meta: unknown };
declare const spec: unknown;
declare const e: { data: unknown };
declare const plugins: { query: (n: string) => Promise<unknown> };
declare const query: (n: string) => Promise<unknown>;
export const a = (row.spec as { text?: string } | null)?.text;
export const b = (spec as { touch?: unknown }).touch;
export const c = ((row.spec ?? row.payload) as { text?: unknown }).text;
export const d = async () => ((await plugins.query("x")) as { rows: unknown[] }).rows;
export const f = async () => ((await query("x")) as { rows: unknown[] }).rows;
export const g = (e.data as { headers: unknown }).headers;
export const h = (row.meta as { scopes?: string[] }).scopes;
export const i = row.spec as never;
export const j = (row.payload as { text?: string }).text;
`;
  const r = await lintText(code, "apps/api/src/modules/x/application/read.ts");
  expect(r.messages.map((m) => [m.line, m.severity, m.message.slice(0, 11)])).toEqual([
    [7, 2, "plugin-cast"],
    [8, 2, "plugin-cast"],
    [9, 2, "plugin-cast"],
    [10, 2, "plugin-cast"],
    [11, 2, "plugin-cast"],
    [12, 2, "plugin-cast"],
  ]);
  expect((await lintText(code, "apps/api/src/modules/x/read.test.ts")).errorCount).toBe(0);
});

test("bun run lint passes on the repo", () => {
  const r = spawnSync("bun", ["run", "lint"], { cwd: root, encoding: "utf8" });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  // A whole-repo eslint run takes longer than the default limit while the rest of the suite runs alongside it.
}, 60_000);
