// SPDX-License-Identifier: AGPL-3.0-only
// Search Console reads only: the properties the Google account can see, and search analytics for
// one of them. It never adds, verifies or removes a property.
export const searchConsoleManifest = {
  id: "com.trydirex.search-console",
  name: "Google Search Console",
  apiVersion: 1,
  version: "0.1.0",
  minHostVersion: "0.1.0",
  trust: "first_party",
  connections: [{ key: "google_search_console", auth: "oauth2" }],
  egress: { hosts: ["searchconsole.googleapis.com"] },
  capabilities: [
    { kind: "query", name: "search.properties", connection: "google_search_console" },
    { kind: "query", name: "search.analytics", connection: "google_search_console" },
  ],
} as const;
