// SPDX-License-Identifier: AGPL-3.0-only
// A mailbox reached with an address and password, on any mail service. Six capabilities and
// nothing else: no code path can delete, move, flag or append mail. The server is whatever the
// person typed, so the host list is empty, which only a first-party plugin may do.
export const imapSmtpManifest = {
  id: "com.trydirex.imap-smtp",
  apiVersion: 1,
  version: "0.1.0",
  minHostVersion: "0.1.0",
  trust: "first_party",
  connections: [{ key: "imap_smtp", auth: "basic" }],
  egress: { hosts: [] },
  capabilities: [
    { kind: "effect", name: "email.send", connection: "imap_smtp", dedupe: "queryable", risk: "medium", reachesPerson: true },
    { kind: "effect", name: "mailbox.probe", connection: "imap_smtp", dedupe: "queryable", risk: "low", reachesPerson: false },
    { kind: "trigger", name: "email.received", connection: "imap_smtp", source: "poll", pollIntervalMs: 60_000 },
    { kind: "query", name: "mailbox.profile", connection: "imap_smtp" },
    { kind: "query", name: "mail.from", connection: "imap_smtp" },
    { kind: "query", name: "mailbox.probe_read", connection: "imap_smtp" },
  ],
} as const;
