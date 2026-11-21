// SPDX-License-Identifier: AGPL-3.0-only
// The root key at startup, against a real database. One deployment row per test database,
// so these run in order, like a deployment's life.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { generateKeyFile, masterRootKey, rootKeyFromEnv } from "./adapters/crypto";
import { createVault } from "./application/secrets";
import { ensureRootKey, rootKeyProblem } from "./index";
import { vaultDb } from "./test-helpers";

const dataDir = () => join(mkdtempSync(join(tmpdir(), "direx-root-")), "data");
const DIR = dataDir();
const env = { DIREX_DATA_DIR: DIR };
const file = join(DIR, "master.key");

test("generating twice at once publishes one key, and neither call replaces it", async () => {
  const path = join(dataDir(), "master.key");
  const results = await Promise.all(Array.from({ length: 20 }, async () => generateKeyFile(path)));
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  const first = readFileSync(path, "utf8");
  expect(generateKeyFile(path)).toBe(false);
  expect(readFileSync(path, "utf8")).toBe(first);
});

test("a first run generates a key, says where it is, and never logs the key", async () => {
  const lines: string[] = [];
  const root = await ensureRootKey(env, (l) => lines.push(l));
  expect(root.id).toMatch(/^master-/);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain(file);
  expect(lines[0]).toContain("Back this file up");
  expect(lines[0]).not.toContain(readFileSync(file, "utf8").trim());
});

test("the next run reuses it and logs nothing", async () => {
  const lines: string[] = [];
  const before = readFileSync(file, "utf8");
  const first = rootKeyFromEnv(env);
  expect((await ensureRootKey(env, (l) => lines.push(l))).id).toBe(first.id);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(lines).toEqual([]);
});

test("doctor's check finds no problem with the right key, and a missing or different one, writing nothing", async () => {
  expect(await rootKeyProblem(env)).toBeNull();
  const elsewhere = dataDir();
  expect(await rootKeyProblem({ DIREX_DATA_DIR: elsewhere })).toContain("restore the key file");
  expect(existsSync(join(elsewhere, "master.key"))).toBe(false);
  expect(await rootKeyProblem({ DIREX_MASTER_KEY_FILE: join(elsewhere, "gone.key") })).toContain("restore the key file");
  generateKeyFile(join(elsewhere, "master.key"));
  expect(await rootKeyProblem({ DIREX_DATA_DIR: elsewhere })).toContain("restore the key file");
});

test("doctor's check names a Workspace whose data key another root key wrapped, and only that one", async () => {
  const { newWorkspace, close } = vaultDb();
  try {
    const sample = { actorUserId: "", scope: "workspace" as const, kind: "api_key" as const, key: "k", name: "N", value: { key: "x" }, meta: {} };
    const seal = async (rootKey: ReturnType<typeof masterRootKey>) => {
      const { ws, owner } = await newWorkspace();
      const r = await createVault({ rootKey, now: () => new Date() }).create({ ...sample, workspaceId: ws, actorUserId: owner });
      expect(r.ok).toBe(true);
      return ws;
    };
    const orphan = await seal(masterRootKey(Buffer.alloc(32, 9)));
    const fine = await seal(rootKeyFromEnv(env));
    const problem = await rootKeyProblem(env);
    expect(problem).toContain(orphan);
    expect(problem).not.toContain(fine);
    expect(problem).toContain("another root key");
  } finally {
    await close();
  }
});

test("an environment key beats a named file, which beats the default path", () => {
  const key = Buffer.alloc(32, 1).toString("hex");
  const named = join(mkdtempSync(join(tmpdir(), "direx-root-")), "k");
  writeFileSync(named, Buffer.alloc(32, 2).toString("hex"), { mode: 0o600 });
  const fromFile = rootKeyFromEnv({ ...env, DIREX_MASTER_KEY_FILE: named }).id;
  const fromKey = rootKeyFromEnv({ ...env, DIREX_MASTER_KEY_FILE: named, DIREX_MASTER_KEY: key }).id;
  expect(new Set([fromFile, fromKey, rootKeyFromEnv(env).id]).size).toBe(3);
});

test("a named key file that is missing is an error, and nothing is generated", async () => {
  const dir = dataDir();
  await expect(ensureRootKey({ DIREX_DATA_DIR: dir, DIREX_MASTER_KEY_FILE: join(dir, "gone") })).rejects.toThrow();
  expect(() => statSync(join(dir, "master.key"))).toThrow();
});

test("a different key refuses to start and names both ids", async () => {
  const original = rootKeyFromEnv(env).id;
  const other = { DIREX_DATA_DIR: dataDir() , DIREX_MASTER_KEY: Buffer.alloc(32, 9).toString("hex") };
  const id = rootKeyFromEnv(other).id;
  const refusal = ensureRootKey(other);
  await expect(refusal).rejects.toThrow(id);
  await expect(refusal).rejects.toThrow(original);
});

test("a supplied key is checked against the recorded one like a key from env, and generates nothing", async () => {
  const recorded = rootKeyFromEnv(env);
  const bare = { DIREX_DATA_DIR: dataDir() };
  const lines: string[] = [];
  expect(await ensureRootKey(bare, (l) => lines.push(l), recorded)).toBe(recorded);
  expect(lines).toEqual([]);
  expect(existsSync(join(bare.DIREX_DATA_DIR, "master.key"))).toBe(false);
  const other = masterRootKey(Buffer.alloc(32, 7));
  const refusal = ensureRootKey(bare, () => undefined, other);
  await expect(refusal).rejects.toThrow(other.id);
  await expect(refusal).rejects.toThrow(recorded.id);
});

test("a supplied key refuses to start while env also names one, so only one key can run", async () => {
  const recorded = rootKeyFromEnv(env);
  for (const named of [{ DIREX_MASTER_KEY: "11".repeat(32) }, { DIREX_MASTER_KEY_FILE: file }]) {
    await expect(ensureRootKey(named, () => undefined, recorded)).rejects.toThrow("a root key was supplied to runServer, so DIREX_MASTER_KEY and DIREX_MASTER_KEY_FILE must be unset");
  }
});

test("a lost key refuses to start and generates nothing", async () => {
  rmSync(file);
  await expect(ensureRootKey(env)).rejects.toThrow(/no root key found.*Restore its key file/);
  expect(() => statSync(file)).toThrow();
});
