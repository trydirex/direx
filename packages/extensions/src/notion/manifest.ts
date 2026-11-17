// SPDX-License-Identifier: AGPL-3.0-only
// Notion: the pages and databases a person shared with Direx's integration, one page's text and one
// database's rows. Its one write sets an imported row's status and link, under a recorded yes for that
// source (ADR 0025). It never creates or deletes anything, and never changes any other property. Two ways
// in, each capability on both: self-host types a Notion internal integration's token into the vault, and
// cloud connects Direx's unlisted public integration through Notion's OAuth.
export const notionManifest = {
  id: "com.trydirex.notion",
  name: "Notion",
  apiVersion: 1,
  version: "0.1.0",
  minHostVersion: "0.1.0",
  trust: "first_party",
  connections: [
    { key: "notion", auth: "api_key" },
    { key: "notion_oauth", auth: "oauth2" },
  ],
  egress: { hosts: ["api.notion.com"] },
  capabilities: [
    { kind: "query", name: "docs.sources", connection: "notion", alsoConnections: ["notion_oauth"] },
    { kind: "query", name: "docs.page_text", connection: "notion", alsoConnections: ["notion_oauth"] },
    { kind: "query", name: "docs.rows", connection: "notion", alsoConnections: ["notion_oauth"] },
    // ADR 0025: a row's status, written back only under a person's recorded yes for that source.
    { kind: "effect", name: "docs.row.update", connection: "notion", alsoConnections: ["notion_oauth"], dedupe: "queryable", risk: "low", reachesPerson: false },
  ],
} as const;
