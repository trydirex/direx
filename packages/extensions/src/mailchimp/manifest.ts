// SPDX-License-Identifier: AGPL-3.0-only
// Mailchimp reads one list's members (Mailchimp calls a list an audience), the account's lists and a
// campaign's report, with the API key a person typed into the vault. It never adds, edits or deletes
// members.
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
    { kind: "query", name: "newsletter.subscribers", connection: "mailchimp" },
    { kind: "query", name: "newsletter.profile", connection: "mailchimp" },
    { kind: "query", name: "newsletter.stats", connection: "mailchimp" },
    { kind: "query", name: "newsletter.lists", connection: "mailchimp" },
  ],
} as const;
