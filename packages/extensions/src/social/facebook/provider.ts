// SPDX-License-Identifier: AGPL-3.0-only
// Facebook Login, manual flow. A person may grant only part of what is asked, and the token response doesn't
// say which, so granted scopes come from /me/permissions. No server renewal is documented: 60 days, then reconnect.
const GRAPH = "https://graph.facebook.com/v26.0";

const SIGN_IN = ["pages_show_list"] as const;
export const FACEBOOK_SCOPES = [...SIGN_IN, "pages_manage_posts", "pages_read_engagement", "pages_manage_engagement"] as const;

export const FACEBOOK_PROVIDER = {
  connection: "facebook",
  authorizeUrl: "https://www.facebook.com/v26.0/dialog/oauth",
  tokenUrl: `${GRAPH}/oauth/access_token`,
  revokeUrl: `${GRAPH}/{accountId}/permissions`,
  revokeMethod: "DELETE",
  issuers: [],
  scopes: FACEBOOK_SCOPES,
  requiredScopes: SIGN_IN,
  extraParams: {},
  pkce: false,
  codeMethod: "GET",
  scopeSeparator: ",",
  scopeSource: "identity",
  longToken: { url: `${GRAPH}/oauth/access_token`, grantType: "fb_exchange_token", tokenParam: "fb_exchange_token", sendClientId: true },
  renewal: { kind: "reconnect" },
} as const;
