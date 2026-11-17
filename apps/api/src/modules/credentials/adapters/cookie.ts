// SPDX-License-Identifier: AGPL-3.0-only
// The OAuth state cookie, sealed with a key derived from the root key. It holds the PKCE
// verifier, so it is never readable or forgeable by the browser.
import { openValue, sealValue, type RootKey } from "./crypto";

export const STATE_COOKIE = "direx_oauth";
export const STATE_TTL_MS = 10 * 60_000;
const AAD = "oauth-state";

export type OAuthState = {
  state: string;
  verifier: string;
  workspaceId: string;
  userId: string;
  connection: string;
  expiresAt: number;
};

export function sealState(root: RootKey, s: OAuthState): string {
  const { ciphertext, nonce } = sealValue(root.derive("oauth-state"), s, AAD);
  return `${nonce.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

/** The state, or null for a cookie that is malformed or was not sealed by this root key. */
export function openState(root: RootKey, cookie: string): OAuthState | null {
  const [nonce, ciphertext] = cookie.split(".");
  if (!nonce || !ciphertext) return null;
  try {
    const sealed = { nonce: Buffer.from(nonce, "base64url"), ciphertext: Buffer.from(ciphertext, "base64url") };
    return openValue(root.derive("oauth-state"), sealed, AAD) as OAuthState;
  } catch {
    return null;
  }
}
