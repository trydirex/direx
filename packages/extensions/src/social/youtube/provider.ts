// SPDX-License-Identifier: AGPL-3.0-only
// YouTube on Google's OAuth, as its own connection with its own app. Consent is offline and always
// prompted, so Google returns a refresh token every time. Reading the person's own channel is all it asks.
import { GOOGLE_PROVIDER } from "../../google";

export const YOUTUBE_SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"] as const;

export const YOUTUBE_PROVIDER = {
  connection: "youtube",
  authorizeUrl: GOOGLE_PROVIDER.authorizeUrl,
  tokenUrl: GOOGLE_PROVIDER.tokenUrl,
  revokeUrl: GOOGLE_PROVIDER.revokeUrl,
  issuers: [],
  scopes: YOUTUBE_SCOPES,
  requiredScopes: YOUTUBE_SCOPES,
  extraParams: GOOGLE_PROVIDER.extraParams,
} as const;
