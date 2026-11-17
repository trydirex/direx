// SPDX-License-Identifier: AGPL-3.0-only
// The manifest every test fixture plugin uses.
export const behaveManifest = {
  id: "com.example.behave",
  apiVersion: 1,
  version: "1.0.0",
  minHostVersion: "0.1.0",
  trust: "first_party",
  connections: [{ key: "svc", auth: "oauth2" }],
  egress: { hosts: ["api.example.com"] },
  capabilities: [
    { kind: "effect", name: "behave.send", connection: "svc", dedupe: "blind", risk: "low", reachesPerson: true },
    { kind: "effect", name: "behave.check", connection: "svc", dedupe: "queryable", risk: "low", reachesPerson: false },
    { kind: "query", name: "mailbox.probe_read", connection: "svc" },
    { kind: "trigger", name: "behave.feed", connection: "svc", source: "poll", pollIntervalMs: 60_000 },
    {
      kind: "trigger",
      name: "behave.hook",
      connection: "svc",
      source: "webhook",
      signature: { scheme: "hmac_sha256", header: "x-signature" },
    },
  ],
} as const;

/** The same plugin with an api_key connection instead of oauth2. */
export const keyManifest = { ...behaveManifest, connections: [{ key: "svc", auth: "api_key" }] } as const;
