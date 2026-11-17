// SPDX-License-Identifier: AGPL-3.0-only
// What leaves the vault about a credential: everything but its sealed value.
import type { CredentialRow } from "../adapters/repo";

export type CredentialMeta = Omit<CredentialRow, "ciphertext" | "nonce" | "keyVersion" | "deletedAt">;
export type Refusal<R extends string> = { ok: false; reason: R; detail?: string };
export type Done<T> = { ok: true } & T;

export function metadata(row: CredentialRow): CredentialMeta {
  const { ciphertext: _c, nonce: _n, keyVersion: _k, deletedAt: _d, ...meta } = row;
  return meta;
}
