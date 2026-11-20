// SPDX-License-Identifier: AGPL-3.0-only
// TikTok Login Kit for Web. The client id is called a key on every call, revoke wants the client pair
// too, and web uses state rather than PKCE. Lifetimes come from each response, and every refresh
// hands back a new refresh token, which the vault keeps.
export const TIKTOK_SCOPES = ["user.info.basic"] as const;

export const TIKTOK_PROVIDER = {
  connection: "tiktok",
  authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
  tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
  revokeUrl: "https://open.tiktokapis.com/v2/oauth/revoke/",
  issuers: [],
  scopes: TIKTOK_SCOPES,
  requiredScopes: TIKTOK_SCOPES,
  extraParams: {},
  clientIdParam: "client_key",
  revokeClient: true,
  pkce: false,
  scopeSeparator: ",",
} as const;
