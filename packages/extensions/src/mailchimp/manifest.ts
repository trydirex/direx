// SPDX-License-Identifier: AGPL-3.0-only
// Mailchimp drafts and sends campaigns to one chosen list (Mailchimp calls it an audience), and reads
// that list's members, the account's lists and a campaign's report, with the API key a person typed
// into the vault. It never adds, edits or deletes members, and never schedules inside Mailchimp.
export const mailchimpManifest = {
  id: "com.trydirex.mailchimp",
  name: "Mailchimp",
  apiVersion: 1,
  version: "0.1.0",
  minHostVersion: "0.1.0",
  trust: "first_party",
  connections: [{ key: "mailchimp", auth: "api_key" }],
  // Each account lives in one data center, named at the end of its key, such as us21.api.mailchimp.com.
  egress: { hosts: ["*.api.mailchimp.com"] },
  capabilities: [
    { kind: "effect", name: "newsletter.draft", connection: "mailchimp", dedupe: "queryable", risk: "low", reachesPerson: false },
    { kind: "effect", name: "newsletter.send", connection: "mailchimp", dedupe: "queryable", risk: "high", reachesPerson: true },
    { kind: "effect", name: "newsletter.cancel", connection: "mailchimp", dedupe: "queryable", risk: "low", reachesPerson: false },
    // Sends at once, so Direx calls it at the Issue's time. Up to a dozen calls, each with its own timeout.
    { kind: "effect", name: "newsletter.publish", connection: "mailchimp", dedupe: "queryable", risk: "high", reachesPerson: true, timeoutMs: 4 * 60_000 },
    { kind: "query", name: "newsletter.subscribers", connection: "mailchimp" },
    { kind: "query", name: "newsletter.profile", connection: "mailchimp" },
    { kind: "query", name: "newsletter.stats", connection: "mailchimp" },
    { kind: "query", name: "newsletter.lists", connection: "mailchimp" },
  ],
} as const;
