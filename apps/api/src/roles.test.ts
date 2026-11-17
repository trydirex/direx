// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { assertRoleAllowed, assertSharedMedia, healthOnly, roleFromEnv } from "./roles";
import { loadDeployment } from "./startup";

const KEY = "11".repeat(32);

test("a process with no role set runs as all, so self-host stays one process", () => {
  expect(roleFromEnv({})).toBe("all");
});

test("each of the three roles is read as given", () => {
  for (const role of ["all", "api", "worker"] as const) expect(roleFromEnv({ DIREX_ROLE: role })).toBe(role);
});

test("any other role stops the start and names the three allowed", () => {
  for (const value of ["", "API", "web", "both"]) expect(() => roleFromEnv({ DIREX_ROLE: value })).toThrow(`DIREX_ROLE must be all, api or worker, not ${value}`);
});

test("a split role refuses self-host, and refuses a root key that isn't in DIREX_MASTER_KEY", () => {
  for (const role of ["api", "worker"] as const) {
    expect(() => assertRoleAllowed(role, "self_host", { DIREX_MASTER_KEY: KEY })).toThrow(`DIREX_ROLE=${role} is for Direx cloud only`);
    expect(() => assertRoleAllowed(role, "cloud", { DIREX_MASTER_KEY_FILE: "/run/secrets/key" })).toThrow(`DIREX_ROLE=${role} needs the root key in DIREX_MASTER_KEY`);
    expect(() => assertRoleAllowed(role, "cloud", { DIREX_DATA_DIR: "/data" })).toThrow(`DIREX_ROLE=${role} needs the root key in DIREX_MASTER_KEY`);
    expect(() => assertRoleAllowed(role, "cloud", { DIREX_MASTER_KEY: KEY })).not.toThrow();
  }
});

test("a split role refuses media on local disk", () => {
  for (const role of ["api", "worker"] as const) {
    expect(() => assertSharedMedia(role, null)).toThrow(`DIREX_ROLE=${role} needs media on object storage`);
    expect(() => assertSharedMedia(role, "https://k:s@s3.test/media")).not.toThrow();
  }
});

test("all refuses none of it: self-host, a key file and disk media stay as they are", () => {
  expect(() => assertRoleAllowed("all", "self_host", { DIREX_DATA_DIR: "/data" })).not.toThrow();
  expect(() => assertSharedMedia("all", null)).not.toThrow();
});

test("a worker answers its health check and nothing else: no product route, no web app", async () => {
  const health = healthOnly(new Request("http://w/health"));
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ ok: true });
  for (const path of ["/", "/api/items", "/api/health", "/health/x"]) expect(healthOnly(new Request(`http://w${path}`)).status).toBe(404);
});

test("a refused split start writes no root key file, even with a data dir to write it in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "direx-role-"));
  await expect(loadDeployment({ DIREX_ROLE: "api", DIREX_DEPLOYMENT: "cloud", DIREX_DATA_DIR: dir }, () => {})).rejects.toThrow("needs the root key in DIREX_MASTER_KEY");
  await expect(loadDeployment({ DIREX_ROLE: "worker", DIREX_DATA_DIR: dir }, () => {})).rejects.toThrow("is for Direx cloud only");
  expect(readdirSync(dir)).toEqual([]);
});
