// SPDX-License-Identifier: AGPL-3.0-only
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import {
  dekCache,
  masterRootKey,
  newDataKey,
  openValue,
  rootKeyFromEnv,
  sealValue,
  unwrapDataKey,
  valueAad,
} from "./adapters/crypto";
import vector from "./fixtures/node-vector.json";

const hex = (s: string) => Buffer.from(s, "hex");
const root = masterRootKey(Buffer.alloc(32, 1));
const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const C1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("Bun decrypts what Node encrypted, and derives the same HKDF key", () => {
  const { aes, hkdf } = vector;
  const sealed = { ciphertext: hex(aes.ciphertext), nonce: hex(aes.nonce) };
  expect(openValue(hex(aes.key), sealed, aes.aad)).toEqual(JSON.parse(aes.plaintext));
  expect(masterRootKey(hex(hkdf.master)).derive(hkdf.purpose).toString("hex")).toBe(hkdf.derived);
});

test("a value round-trips, and its ciphertext contains it in no encoding", () => {
  const dek = newDataKey();
  const secret = "sk-live-1234567890abcdef";
  const value = { key: secret };
  const s = sealValue(dek, value, valueAad(W1, C1, 1));
  expect(openValue(dek, s, valueAad(W1, C1, 1))).toEqual(value);
  const stored = Buffer.concat([s.ciphertext, s.nonce]);
  for (const enc of ["utf8", "base64", "hex", "base64url"] as const) {
    expect(stored.toString("latin1")).not.toContain(Buffer.from(secret).toString(enc));
    expect(stored.toString(enc)).not.toContain(secret);
  }
});

test("a ciphertext moved to another row, Workspace or key version does not decrypt", () => {
  const dek = newDataKey();
  const s = sealValue(dek, { value: "x" }, valueAad(W1, C1, 1));
  for (const aad of [valueAad(W1, C2, 1), valueAad(W2, C1, 1), valueAad(W1, C1, 2)]) {
    expect(() => openValue(dek, s, aad)).toThrow("credential: decryption failed");
  }
  expect(() => openValue(newDataKey(), s, valueAad(W1, C1, 1))).toThrow("credential: decryption failed");
});

test("a data key wrapped for one Workspace does not unwrap for another", async () => {
  const dek = newDataKey();
  const wrapped = await root.wrap(dek, W1);
  expect(await unwrapDataKey(root, { wrapped, rootKeyId: root.id, workspaceId: W1 })).toEqual(dek);
  await expect(root.unwrap(wrapped, W2)).rejects.toThrow("data key: decryption failed");
});

test("a wrong root key is named by id, and the error carries no key bytes", async () => {
  const other = masterRootKey(Buffer.alloc(32, 2));
  const wrapped = await root.wrap(newDataKey(), W1);
  const err = await unwrapDataKey(other, { wrapped, rootKeyId: root.id, workspaceId: W1 }).catch((e: Error) => e);
  expect((err as Error).message).toContain(root.id);
  expect((err as Error).message).toContain(other.id);
  expect((err as Error).message).not.toContain(Buffer.alloc(32, 1).toString("hex"));
  expect(root.id).toMatch(/^master-[0-9a-f]{12}$/);
  expect(root.id).not.toBe(other.id);
});

test("the root key comes from DIREX_MASTER_KEY in hex or base64, and is required", () => {
  const key = Buffer.alloc(32, 1);
  expect(rootKeyFromEnv({ DIREX_MASTER_KEY: key.toString("hex") }).id).toBe(root.id);
  expect(rootKeyFromEnv({ DIREX_MASTER_KEY: key.toString("base64") }).id).toBe(root.id);
  expect(() => rootKeyFromEnv({})).toThrow("DIREX_MASTER_KEY or DIREX_MASTER_KEY_FILE must be set");
  expect(() => rootKeyFromEnv({ DIREX_MASTER_KEY: "short" })).toThrow("must be 32 bytes");
});

test("a key file is used only when no other user can read it", () => {
  const file = join(mkdtempSync(join(tmpdir(), "direx-key-")), "master.key");
  writeFileSync(file, `${Buffer.alloc(32, 1).toString("hex")}\n`);
  chmodSync(file, 0o644);
  expect(() => rootKeyFromEnv({ DIREX_MASTER_KEY_FILE: file })).toThrow("readable by group or others");
  chmodSync(file, 0o600);
  expect(rootKeyFromEnv({ DIREX_MASTER_KEY_FILE: file }).id).toBe(root.id);
});

test("an unwrapped data key is cached until its TTL runs out", () => {
  let t = 0;
  const cache = dekCache(() => new Date(t), 1000);
  const dek = newDataKey();
  cache.set(W1, 1, dek);
  expect(cache.get(W1, 1)).toBe(dek);
  expect(cache.get(W1, 2)).toBeUndefined();
  expect(cache.get(W2, 1)).toBeUndefined();
  t = 1000;
  expect(cache.get(W1, 1)).toBeUndefined();
});

test("V27: only the vault's adapters encrypt or decrypt", () => {
  const repo = join(import.meta.dirname, "../../../../..");
  const callers = ["apps", "packages"].flatMap((dir) =>
    readdirSync(join(repo, dir), { recursive: true, encoding: "utf8" })
      .filter((f) => /\.tsx?$/.test(f) && !/(^|\/)(node_modules|dist)\//.test(f))
      .map((f) => join(dir, f))
      .filter((f) => /\bcreate(Cipher|Decipher)iv\b/.test(readFileSync(join(repo, f), "utf8"))),
  );
  expect(callers.map((f) => relative(".", f)).filter((f) => !f.endsWith("crypto.test.ts"))).toEqual([
    "apps/api/src/modules/credentials/adapters/crypto.ts",
  ]);
});
