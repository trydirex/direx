// SPDX-License-Identifier: AGPL-3.0-only
// beehiiv drafts posts and sends them, and reads the subscriber list, the publication and a post's
// stats, with the API key a person typed into the vault. It never adds, edits or deletes
// subscribers. beehiiv has nowhere hidden to mark a post with the Action, so every effect is blind:
// an answer that never arrives is held for a person instead of retried.
export const beehiivManifest = {
  id: "com.trydirex.beehiiv",
  name: "beehiiv",
  apiVersion: 1,
  version: "0.1.0",
  minHostVersion: "0.1.0",
  trust: "first_party",
  connections: [{ key: "beehiiv", auth: "api_key" }],
  egress: { hosts: ["api.beehiiv.com"] },
  capabilities: [
    { kind: "effect", name: "newsletter.draft", connection: "beehiiv", dedupe: "blind", risk: "low", reachesPerson: false },
    { kind: "effect", name: "newsletter.send", connection: "beehiiv", dedupe: "blind", risk: "high", reachesPerson: true },
    { kind: "effect", name: "newsletter.cancel", connection: "beehiiv", dedupe: "blind", risk: "low", reachesPerson: false },
    { kind: "effect", name: "newsletter.publish", connection: "beehiiv", dedupe: "blind", risk: "high", reachesPerson: true },
    { kind: "query", name: "newsletter.subscribers", connection: "beehiiv" },
    { kind: "query", name: "newsletter.profile", connection: "beehiiv" },
    { kind: "query", name: "newsletter.stats", connection: "beehiiv" },
  ],
} as const;
