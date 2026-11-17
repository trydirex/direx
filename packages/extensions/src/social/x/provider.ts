// SPDX-License-Identifier: AGPL-3.0-only
// X's OAuth 2.0 user context: PKCE required, the client pair in a Basic header, two-hour tokens refreshed
// with offline.access. Its docs don't say whether the token response lists scopes.
const SIGN_IN = ["tweet.read", "users.read", "offline.access"] as const;
/** media.write is for video. A connection made before it was asked for sees a reconnect for video only. */
export const X_SCOPES = [...SIGN_IN, "tweet.write", "media.write"] as const;

export const X_PROVIDER = {
  connection: "x",
  authorizeUrl: "https://x.com/i/oauth2/authorize",
  tokenUrl: "https://api.x.com/2/oauth2/token",
  revokeUrl: "https://api.x.com/2/oauth2/revoke",
  issuers: [],
  scopes: X_SCOPES,
  requiredScopes: SIGN_IN,
  extraParams: {},
  tokenAuth: "basic",
  scopeSource: "token_or_asked",
} as const;
