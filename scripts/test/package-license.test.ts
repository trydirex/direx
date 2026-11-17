// SPDX-License-Identifier: AGPL-3.0-only
import { join } from "node:path";
import { expect, test } from "vitest";

const scripts = join(import.meta.dirname, "..");
const fixtures = join(import.meta.dirname, "fixtures/package-license");

function run(check: "package" | "license", root?: string) {
  const args = [process.execPath, join(scripts, `check-${check}.ts`)];
  const r = Bun.spawnSync(root ? [...args, "--root", join(fixtures, root)] : args);
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

test.each(["package", "license"] as const)("check:%s passes on a clean tree and the real repo", (check) => {
  expect(run(check, "clean")).toEqual({ code: 0, out: "" });
  expect(run(check)).toEqual({ code: 0, out: "" });
});

test.each([
  ["package", "postinstall", "install-time-code"],
  ["package", "patched-dependencies", "install-time-code"],
  ["package", "trusted-dependencies", "install-time-code"],
  ["package", "redis-dependency", "second-datastore"],
  ["license", "missing-header", "spdx-header"],
  ["license", "plugin-sdk-wrong-licence", "spdx-header"],
  ["license", "plugin-sdk-agpl", "spdx-header"],
  ["license", "enterprise-string", "enterprise-licence"],
  ["license", "cloud-package", "cloud-package"],
] as const)("check:%s fails on %s with %s", (check, fixture, rule) => {
  const r = run(check, fixture);
  expect(r.code).toBe(1);
  expect(r.out).toMatch(new RegExp(`^${rule} `, "m"));
});
