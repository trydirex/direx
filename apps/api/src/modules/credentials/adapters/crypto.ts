// SPDX-License-Identifier: AGPL-3.0-only
// Envelope encryption. Each Workspace has a data key (DEK) wrapped by the root key; each
// credential value is AES-256-GCM under that DEK, with the row's identity as associated
// data, so a ciphertext copied to another row or Workspace does not decrypt. The root is
// a master key here; the cloud repo supplies a KMS-backed RootKey with the same shape.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type RootKey = {
  /** Stored next to each wrapped DEK, so a wrong key is named, not guessed. */
  id: string;
  wrap(dek: Buffer, workspaceId: string): Promise<Buffer>;
  unwrap(wrapped: Buffer, workspaceId: string): Promise<Buffer>;
  /** A 32-byte key for a named purpose, such as sealing the OAuth state cookie. */
  derive(purpose: string): Buffer;
};

export type Sealed = { ciphertext: Buffer; nonce: Buffer };

const IV = 12;
const TAG = 16;

function encrypt(key: Buffer, plaintext: Buffer, aad: string): Sealed {
  const nonce = randomBytes(IV);
  const c = createCipheriv("aes-256-gcm", key, nonce).setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return { ciphertext: Buffer.concat([body, c.getAuthTag()]), nonce };
}

/** Throws a fixed message on any failure: GCM errors say nothing useful and must not carry data. */
function decrypt(key: Buffer, s: Sealed, aad: string, what: string): Buffer {
  try {
    const d = createDecipheriv("aes-256-gcm", key, s.nonce, { authTagLength: TAG }).setAAD(Buffer.from(aad));
    d.setAuthTag(s.ciphertext.subarray(-TAG));
    return Buffer.concat([d.update(s.ciphertext.subarray(0, -TAG)), d.final()]);
  } catch {
    throw new Error(`${what}: decryption failed`);
  }
}

export const newDataKey = () => randomBytes(32);

/** Associated data for a credential value: workspace, credential and key version. */
export const valueAad = (workspaceId: string, credentialId: string, keyVersion: number) =>
  `${workspaceId}|${credentialId}|${keyVersion}`;

export function sealValue(dek: Buffer, value: unknown, aad: string): Sealed {
  return encrypt(dek, Buffer.from(JSON.stringify(value)), aad);
}

export function openValue(dek: Buffer, s: Sealed, aad: string): unknown {
  return JSON.parse(decrypt(dek, s, aad, "credential").toString());
}

export function masterRootKey(key: Buffer): RootKey {
  if (key.length !== 32) throw new Error("master key must be 32 bytes");
  const derive = (purpose: string) => Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), `direx/${purpose}`, 32));
  const wrapKey = derive("dek-wrap");
  const aad = (workspaceId: string) => `dek|${workspaceId}`;
  return {
    // A keyed hash of a constant: identifies the key without revealing anything about it.
    id: `master-${createHmac("sha256", key).update("direx/root-key-id").digest("hex").slice(0, 12)}`,
    async wrap(dek, workspaceId) {
      const s = encrypt(wrapKey, dek, aad(workspaceId));
      return Buffer.concat([s.nonce, s.ciphertext]);
    },
    async unwrap(wrapped, workspaceId) {
      const s = { nonce: wrapped.subarray(0, IV), ciphertext: wrapped.subarray(IV) };
      return decrypt(wrapKey, s, aad(workspaceId), "data key");
    },
    derive,
  };
}

/** A data key another root key wrapped. Only restoring that key can read it. */
export class RootKeyMismatch extends Error {}

/** Checks the root key id first, so a wrong key is reported as such rather than as tampering. */
export async function unwrapDataKey(
  root: RootKey,
  row: { wrapped: Buffer; rootKeyId: string; workspaceId: string },
): Promise<Buffer> {
  if (row.rootKeyId !== root.id) {
    throw new RootKeyMismatch(`data key was wrapped by root key ${row.rootKeyId}, but this process has root key ${root.id}`);
  }
  return root.unwrap(row.wrapped, row.workspaceId);
}

function parseKey(raw: string, source: string): Buffer {
  const s = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  if (key.length !== 32) throw new Error(`${source} must be 32 bytes, as 64 hex characters or base64`);
  return key;
}

type Env = Record<string, string | undefined>;

/** Direx's own files: DIREX_DATA_DIR, else ~/.direx. Undefined with neither that nor a home. */
export const dataDir = (env: Env): string | undefined => env.DIREX_DATA_DIR ?? (env.HOME ? join(env.HOME, ".direx") : undefined);

/** Where a generated key lives, in the data directory. */
export function defaultKeyPath(env: Env): string | undefined {
  const dir = dataDir(env);
  return dir ? join(dir, "master.key") : undefined;
}

/** Whether a key is set up. A named file that is missing counts: it is an error, not a reason to generate. */
export const rootKeyConfigured = (env: Env) => {
  const path = defaultKeyPath(env);
  return Boolean(env.DIREX_MASTER_KEY || env.DIREX_MASTER_KEY_FILE || (path && existsSync(path)));
};

/**
 * Creates a new key file only its owner can read. Publishing through a hard link fails if
 * the file appeared meanwhile, so processes starting at once all end up with one key.
 */
export function generateKeyFile(path: string): boolean {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(temp, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  try {
    linkSync(temp, path);
    return true;
  } catch (e) {
    if ((e as { code?: string }).code !== "EEXIST") throw e;
    return false;
  } finally {
    unlinkSync(temp);
  }
}

function keyFromFile(file: string, source: string): RootKey {
  if (statSync(file).mode & 0o077) throw new Error(`${file} is readable by group or others; chmod 600 it`);
  return masterRootKey(parseKey(readFileSync(file, "utf8"), source));
}

/** DIREX_MASTER_KEY, else DIREX_MASTER_KEY_FILE, else a key file at the default path. */
export function rootKeyFromEnv(env: Env = process.env): RootKey {
  if (env.DIREX_MASTER_KEY) return masterRootKey(parseKey(env.DIREX_MASTER_KEY, "DIREX_MASTER_KEY"));
  if (env.DIREX_MASTER_KEY_FILE) return keyFromFile(env.DIREX_MASTER_KEY_FILE, "DIREX_MASTER_KEY_FILE");
  const path = defaultKeyPath(env);
  if (path && existsSync(path)) return keyFromFile(path, path);
  throw new Error("DIREX_MASTER_KEY or DIREX_MASTER_KEY_FILE must be set");
}

/** [DEFAULT] Unwrapped DEKs live in process memory this long. */
export const DEK_TTL_MS = 5 * 60_000;

export function dekCache(now: () => Date, ttlMs = DEK_TTL_MS) {
  const entries = new Map<string, { dek: Buffer; until: number }>();
  const k = (workspaceId: string, keyVersion: number) => `${workspaceId}:${keyVersion}`;
  return {
    get(workspaceId: string, keyVersion: number): Buffer | undefined {
      const e = entries.get(k(workspaceId, keyVersion));
      if (e && e.until > now().getTime()) return e.dek;
      entries.delete(k(workspaceId, keyVersion));
      return undefined;
    },
    set(workspaceId: string, keyVersion: number, dek: Buffer) {
      entries.set(k(workspaceId, keyVersion), { dek, until: now().getTime() + ttlMs });
    },
  };
}
