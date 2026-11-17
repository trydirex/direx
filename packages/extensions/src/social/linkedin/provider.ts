// SPDX-License-Identifier: AGPL-3.0-only
// LinkedIn's OAuth details. Tokens last 60 days. Programmatic refresh is for a limited set of partners,
// so a person reconnects. LinkedIn documents no revoke endpoint and no PKCE on the web flow.
const shared = {
  authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
  tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
  issuers: [],
  extraParams: {},
  pkce: false,
  renewal: { kind: "reconnect" },
  deadTokenErrors: ["invalid_request"],
} as const;

const SIGN_IN = ["openid", "profile"] as const;
export const LINKEDIN_SCOPES = [...SIGN_IN, "w_member_social"] as const;
export const LINKEDIN_PAGE_SCOPES = ["rw_organization_admin"] as const;

export const LINKEDIN_PROVIDER = { ...shared, connection: "linkedin", scopes: LINKEDIN_SCOPES, requiredScopes: SIGN_IN } as const;
export const LINKEDIN_PAGE_PROVIDER = { ...shared, connection: "linkedin_page", scopes: LINKEDIN_PAGE_SCOPES, requiredScopes: LINKEDIN_PAGE_SCOPES } as const;
