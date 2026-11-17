// SPDX-License-Identifier: AGPL-3.0-only
import { join } from "node:path";
import { expect, test } from "vitest";

const script = join(import.meta.dirname, "..", "check-plugin-loading.ts");
const fixtures = join(import.meta.dirname, "fixtures/plugin-loading");

function run(root?: string) {
  const r = Bun.spawnSync(root ? [process.execPath, script, "--root", join(fixtures, root)] : [process.execPath, script]);
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

test("passes on the real repo and on clean code: relative import(), an env built by hand, a test starting the host's worker", () => {
  expect(run()).toEqual({ code: 0, out: "" });
  expect(run("clean")).toEqual({ code: 0, out: "" });
}, 60_000);

test.each([
  ["dynamic-import", "apps/api/src/load.ts:2", /only a fixed relative path/],
  ["computed-import", "apps/api/src/load.ts:2", /only a fixed relative path/],
  ["env-spread", "apps/api/src/run.ts:2", /never the host's process\.env/],
  ["env-property", "apps/api/src/run.ts:3", /never the host's process\.env/],
  ["provider-id", "apps/api/src/route.ts:2", /names the plugin com\.example\.mail/],
  ["provider-capability", "apps/api/src/route.ts:2", /names the plugin com\.example\.mail/],
  ["external-literal", "apps/api/src/wire.ts:2", /only where the sandbox spawner is in use/],
])("fails on %s", (fixture, where, message) => {
  const r = run(fixture);
  expect(r.code).toBe(1);
  expect(r.out).toMatch(new RegExp(`^plugin-boundary ${where}: `, "m"));
  expect(r.out).toMatch(message);
});

test("the Gmail smoke script refuses to run, and sends nothing, without a token and a recipient", () => {
  const env = { PATH: process.env.PATH ?? "" };
  const r = Bun.spawnSync([process.execPath, join(import.meta.dirname, "..", "gmail-smoke.ts")], { env });
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toMatch(/set DIREX_GMAIL_SMOKE_TOKEN/);
});
