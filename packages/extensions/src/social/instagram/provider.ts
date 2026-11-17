// SPDX-License-Identifier: AGPL-3.0-only
// Instagram Login, for professional accounts. A one-hour token is swapped for a 60-day one that renews itself.
const GRAPH = "https://graph.instagram.com";

export const INSTAGRAM_SCOPES = ["instagram_business_basic"] as const;

export const INSTAGRAM_PROVIDER = {
  connection: "instagram",
  authorizeUrl: "https://www.instagram.com/oauth/authorize",
  tokenUrl: "https://api.instagram.com/oauth/access_token",
  issuers: [],
  scopes: INSTAGRAM_SCOPES,
  requiredScopes: INSTAGRAM_SCOPES,
  extraParams: {},
  pkce: false,
  scopeSeparator: ",",
  scopeField: "permissions",
  longToken: { url: `${GRAPH}/access_token`, grantType: "ig_exchange_token", tokenParam: "access_token" },
  renewal: { kind: "self_renew", url: `${GRAPH}/refresh_access_token`, grantType: "ig_refresh_token" },
} as const;
