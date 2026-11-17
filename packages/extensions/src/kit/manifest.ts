// SPDX-License-Identifier: AGPL-3.0-only
// Kit drafts, schedules and unschedules broadcasts, and reads the subscriber list, the account and
// a broadcast's stats, with the API key a person typed into the vault. It never adds, edits or
// deletes subscribers.
export const kitManifest = {
  id: "com.trydirex.kit",
  name: "Kit",
  apiVersion: 1,
  version: "0.1.0",
  minHostVersion: "0.1.0",
  trust: "first_party",
  connections: [{ key: "kit", auth: "api_key" }],
  egress: { hosts: ["api.kit.com"] },
  capabilities: [
    { kind: "effect", name: "newsletter.draft", connection: "kit", dedupe: "queryable", risk: "low", reachesPerson: false },
    { kind: "effect", name: "newsletter.send", connection: "kit", dedupe: "queryable", risk: "high", reachesPerson: true },
    { kind: "effect", name: "newsletter.cancel", connection: "kit", dedupe: "queryable", risk: "low", reachesPerson: false },
    // Kit only schedules a broadcast at least sendDelayMs out, so it is handed an issue that long before its time.
    { kind: "effect", name: "newsletter.publish", connection: "kit", dedupe: "queryable", risk: "high", reachesPerson: true, leadMs: 5 * 60_000 },
    { kind: "query", name: "newsletter.subscribers", connection: "kit" },
    { kind: "query", name: "newsletter.profile", connection: "kit" },
    { kind: "query", name: "newsletter.stats", connection: "kit" },
  ],
} as const;
