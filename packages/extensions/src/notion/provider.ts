// SPDX-License-Identifier: AGPL-3.0-only
// Notion's OAuth details for a public integration, from developers.notion.com (accessed 2026-11-14):
// docs/authorization, reference/create-a-token, reference/revoke-token, reference/introspect-token.
// The token endpoint takes JSON with the client pair as Basic auth, and its answer names the Notion
// workspace (workspace_id, workspace_name), so no further call says who connected. A refresh gives a
// new access and refresh token, which the vault stores each time. Notion has no OAuth scopes: what the
// integration may do is the capabilities ticked on it, and the pages a person shares at consent.
// UNVERIFIED: how long an access token lives (no expires_in is documented), so it is taken to last an
// hour [DEFAULT] and refreshed after; whether PKCE is accepted (not documented, so not sent); and the
// token endpoint's error field (RFC 6749 says `error`, Notion's error bodies say `code`; both are read).
import { NOTION_VERSION } from "./plugin";

export const NOTION_OAUTH_PROVIDER = {
  connection: "notion_oauth",
  authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
  tokenUrl: "https://api.notion.com/v1/oauth/token",
  revokeUrl: "https://api.notion.com/v1/oauth/revoke",
  issuers: [],
  // The capabilities Direx's integration is registered with; Notion grants them all or none.
  scopes: ["read_content", "update_content"],
  requiredScopes: [],
  scopeSource: "fixed",
  extraParams: { owner: "user" },
  pkce: false,
  tokenAuth: "basic",
  tokenBody: "json",
  tokenHeaders: { "notion-version": NOTION_VERSION },
  defaultExpiresIn: 3600,
  tokenIdentity: { accountId: "workspace_id", accountLabel: "workspace_name" },
} as const;
