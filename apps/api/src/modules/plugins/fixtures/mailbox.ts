// SPDX-License-Identifier: AGPL-3.0-only
// A mailbox provider that exists only in tests. If core works with this one, core has no
// provider ties.
import { definePlugin } from "@direx/plugin-sdk";

const manifest = {
  id: "com.example.testmail",
  apiVersion: 1,
  version: "1.0.0",
  minHostVersion: "0.1.0",
  trust: "first_party",
  connections: [{ key: "testmail", auth: "api_key" }],
  egress: { hosts: [] },
  capabilities: [
    { kind: "effect", name: "email.send", connection: "testmail", dedupe: "blind", risk: "medium", reachesPerson: true },
    { kind: "trigger", name: "email.received", connection: "testmail", source: "poll", pollIntervalMs: 60_000 },
    { kind: "query", name: "mailbox.profile", connection: "testmail" },
    { kind: "query", name: "mail.from", connection: "testmail" },
  ],
} as const;

export const testMailManifest = manifest;

export function createTestMail() {
  const sent: unknown[] = [];
  const inbox: { eventId: string; data: unknown }[] = [];
  const plugin = definePlugin({
    manifest,
    effects: {
      "email.send": {
        prepare: async (input) => ({ spec: input, preview: "a test email" }),
        async execute(spec) {
          sent.push(spec);
          return { kind: "sent", providerRef: `test-${sent.length}` };
        },
      },
    },
    queries: {
      "mailbox.profile": async () => ({ emailAddress: "me@test.example" }),
      "mail.from": async () => ({ events: inbox }),
    },
    triggers: {
      "email.received": { poll: async () => ({ events: inbox.splice(0), cursor: "next" }) },
    },
  });
  return { plugin, sent, inbox };
}
