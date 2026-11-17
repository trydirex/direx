// SPDX-License-Identifier: AGPL-3.0-only
// Spec hash and approval signature. HMAC-SHA256 with the Workspace's own key; key_id is
// stored with each approval, so it verifies by the key that signed it.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { bindingBytes, canonicalJson, type Binding } from "../domain/binding";

export type SigningKey = { id: string; secret: string };
/** A Workspace's keys: the one that signs now, and any that signed earlier approvals. */
export type WorkspaceKeys = { current: SigningKey; byId: (id: string) => SigningKey | undefined };
/**
 * Where a Workspace's keys come from. Fetching may reach a key service over the network, so
 * it is always called before a transaction opens, never under a ledger lock.
 */
export type SigningKeys = (workspaceId: string) => Promise<WorkspaceKeys>;

/** Keys that couldn't be loaded. `permanent` when no retry can help, such as a data key another root key wrapped. */
export class KeysUnavailable extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = "KeysUnavailable";
  }
}

/** One key for every Workspace: for tests, which have no vault. */
export const oneKey = (key: SigningKey): SigningKeys => async () => ({ current: key, byId: (id) => (id === key.id ? key : undefined) });

export function specHash(spec: unknown): string {
  return createHash("sha256").update(canonicalJson(spec)).digest("hex");
}

export function sign(b: Binding, key: SigningKey): string {
  return createHmac("sha256", key.secret).update(bindingBytes(b)).digest("base64url");
}

export function verify(b: Binding, signature: string, key: SigningKey): boolean {
  const want = Buffer.from(sign(b, key));
  const got = Buffer.from(signature);
  return want.length === got.length && timingSafeEqual(want, got);
}
