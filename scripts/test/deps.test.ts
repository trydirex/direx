// SPDX-License-Identifier: AGPL-3.0-only
// Each fixture breaks one boundary rule and must fail check:deps.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const root = join(import.meta.dirname, "../..");
const depcruise = join(root, "node_modules/.bin/depcruise");
const config = join(root, ".dependency-cruiser.cjs");

function cruise(cwd: string) {
  const r = Bun.spawnSync([depcruise, "apps", ...(existsSync(join(cwd, "packages")) ? ["packages"] : []), "--config", config], { cwd });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

test.each([
  ["module-internal", "module-entry-only:"],
  ["module-internal", "module-entry-only-cross-module:"],
  ["db-outside-adapters", "db-only-in-adapters:"],
  ["domain-impure", "domain-is-pure:"],
  ["cycle", "no-cycles:"],
  ["dynamic-import", "no-relative-dynamic-import:"],
  ["auth-db-outside-identity", "auth-db-only-in-identity:"],
  ["with-user-outside-identity", "with-user-only-in-identity:"],
  ["use-secret-outside-consumers", "use-secret-only-in-consumers:"],
  ["model-sdk-in-agents", "model-sdk-only-in-models:"],
  ["agents-foreign-table", "agents-own-tables-only:"],
  ["test-support-in-production", "no-test-support-in-production:"],
  ["evals-in-production", "evals-only-in-tests:"],
  ["extensions-in-module", "no-extensions-in-modules:"],
  ["sdk-imports-core", "plugin-sdk-stands-alone:"],
])("fixture %s fails with %s", (fixture, rule) => {
  const { code, out } = cruise(join(import.meta.dirname, "fixtures/deps", fixture));
  expect(out).toContain(rule);
  expect(code).not.toBe(0);
});

test("the repo passes check:deps", () => {
  const r = Bun.spawnSync(["bun", "run", "check:deps"], { cwd: root });
  expect(r.stdout.toString() + r.stderr.toString()).toContain("no dependency violations found");
  expect(r.exitCode).toBe(0);
}, 60_000);
