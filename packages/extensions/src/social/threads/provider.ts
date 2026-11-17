// SPDX-License-Identifier: AGPL-3.0-only
// Threads: a one-hour token with no stated expiry is swapped for a 60-day one that renews itself. The token
// response lists no scopes, and the call that does needs the app's secret, which a plugin never holds.
const GRAPH = "https://graph.threads.com";

const SIGN_IN = ["threads_basic"] as const;
export const THREADS_SCOPES = [...SIGN_IN, "threads_content_publish", "threads_manage_replies"] as const;

export const THREADS_PROVIDER = {
  connection: "threads",
  authorizeUrl: "https://threads.com/oauth/authorize",
  tokenUrl: `${GRAPH}/oauth/access_token`,
  issuers: [],
  scopes: THREADS_SCOPES,
  requiredScopes: SIGN_IN,
  extraParams: {},
  pkce: false,
  scopeSeparator: ",",
  scopeSource: "token_or_asked",
  longToken: { url: `${GRAPH}/access_token`, grantType: "th_exchange_token", tokenParam: "access_token" },
  renewal: { kind: "self_renew", url: `${GRAPH}/refresh_access_token`, grantType: "th_refresh_token" },
} as const;
