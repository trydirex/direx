// SPDX-License-Identifier: AGPL-3.0-only
// The Workspace data keys: created on the first write, unwrapped by the root key, cached
// in process for a few minutes. Every sealed value goes through here.
import { dekCache, newDataKey, openValue, sealValue, unwrapDataKey, valueAad, type RootKey } from "../adapters/crypto";
import { activeKey, insertFirstKey, keyByVersion, type CredentialRow, type WorkspaceTx } from "../adapters/repo";
import type { SecretValue } from "./kinds";

export type Keyring = ReturnType<typeof keyring>;

export function keyring(rootKey: RootKey, now: () => Date) {
  const cache = dekCache(now);

  async function dataKey(tx: WorkspaceTx, workspaceId: string, keyVersion: number): Promise<Buffer> {
    const hit = cache.get(workspaceId, keyVersion);
    if (hit) return hit;
    const row = await keyByVersion(tx, workspaceId, keyVersion);
    if (!row) throw new Error(`data key ${keyVersion} is missing for this Workspace`);
    const dek = await unwrapDataKey(rootKey, { wrapped: row.wrappedDek, rootKeyId: row.rootKeyId, workspaceId });
    cache.set(workspaceId, keyVersion, dek);
    return dek;
  }

  return {
    /** Opens a value sealed for `id`. Throws when it does not decrypt. */
    async openFor(tx: WorkspaceTx, workspaceId: string, id: string, keyVersion: number, sealed: { ciphertext: Buffer; nonce: Buffer }) {
      const dek = await dataKey(tx, workspaceId, keyVersion);
      return openValue(dek, sealed, valueAad(workspaceId, id, keyVersion));
    },

    /** Seals a value for one row with the active key, creating the Workspace's first key if needed. */
    async seal(tx: WorkspaceTx, workspaceId: string, id: string, value: unknown) {
      let key = await activeKey(tx, workspaceId);
      if (!key) {
        const wrappedDek = await rootKey.wrap(newDataKey(), workspaceId);
        // A concurrent first write loses quietly and seals with the winner's key.
        await insertFirstKey(tx, { workspaceId, keyVersion: 1, wrappedDek, rootKeyId: rootKey.id, createdAt: now() });
        key = (await activeKey(tx, workspaceId))!;
      }
      const dek = await dataKey(tx, workspaceId, key.keyVersion);
      return { ...sealValue(dek, value, valueAad(workspaceId, id, key.keyVersion)), keyVersion: key.keyVersion };
    },

    /** The row's value, or null when it does not decrypt (moved, tampered with, or deleted). */
    async open(tx: WorkspaceTx, row: CredentialRow): Promise<SecretValue | null> {
      if (!row.ciphertext || !row.nonce) return null;
      const dek = await dataKey(tx, row.workspaceId, row.keyVersion);
      try {
        const sealed = { ciphertext: row.ciphertext, nonce: row.nonce };
        return openValue(dek, sealed, valueAad(row.workspaceId, row.id, row.keyVersion)) as SecretValue;
      } catch {
        return null;
      }
    },
  };
}
