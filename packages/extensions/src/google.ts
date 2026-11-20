// SPDX-License-Identifier: AGPL-3.0-only
// Google as an OAuth provider for the vault: data only. The client id and secret are added by the
// composition root: the sign-in pair from env for Gmail, and for Search Console the Workspace's
// own app first, then the server's (credentials/index.ts). Consent is separate from sign-in,
// offline and always prompted, so Google returns a refresh token every time.
import { GMAIL_SCOPES } from "./gmail/manifest";

export const GOOGLE_PROVIDER = {
  connection: "google",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  issuers: ["https://accounts.google.com", "accounts.google.com"],
  scopes: [...GMAIL_SCOPES, "openid", "email"],
  requiredScopes: [...GMAIL_SCOPES],
  extraParams: { access_type: "offline", prompt: "consent" },
} as const;

/** Read-only Search Console scope. Never the write scope. */
export const SEARCH_CONSOLE_SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"] as const;

/**
 * Search Console on the same Google app, as its own connection: connecting it asks only for the
 * read-only Search Console scope, never for Gmail, and connecting Gmail never asks for this.
 */
export const GOOGLE_SEARCH_CONSOLE_PROVIDER = {
  ...GOOGLE_PROVIDER,
  connection: "google_search_console",
  scopes: [...SEARCH_CONSOLE_SCOPES, "openid", "email"],
  requiredScopes: [...SEARCH_CONSOLE_SCOPES],
} as const;
