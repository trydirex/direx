// SPDX-License-Identifier: AGPL-3.0-only
// The Gmail plugin's manifest. Twelve capabilities and nothing else: no code path can
// delete, forward, filter or draft mail, and the one label change is taking INBOX off a
// content Placement check after its verdict, never out of spam.

/**
 * The OAuth scopes a Gmail connection asks for. Every Gmail read scope is restricted. gmail.modify
 * allows search (`q`), which gmail.metadata does not, and the one label change placement.archive makes.
 */
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"] as const;

export const gmailManifest = {
  id: "com.trydirex.gmail",
  apiVersion: 1,
  version: "0.2.0",
  // 0.2.0: the host hands the reply poll the Placement checks it must not fetch.
  minHostVersion: "0.2.0",
  trust: "first_party",
  connections: [{ key: "google", auth: "oauth2" }],
  egress: { hosts: ["gmail.googleapis.com"] },
  capabilities: [
    { kind: "effect", name: "email.send", connection: "google", dedupe: "queryable", risk: "medium", reachesPerson: true },
    // A test message to the Mailbox's own address, to see which headers survive the trip.
    { kind: "effect", name: "mailbox.probe", connection: "google", dedupe: "queryable", risk: "low", reachesPerson: false },
    // The reply that asks to join the Placement circle, to the signer who emailed join code part 1. Core,
    // not this line, decides it reaches no Person. Blind: it carries no X-Direx-Action to find it by.
    { kind: "effect", name: "placement.join", connection: "google", dedupe: "blind", risk: "low", reachesPerson: false },
    // A Placement check to another Circle member. Blind for the same reason: reconcile is handed no
    // subject or recipient to search Sent by.
    { kind: "effect", name: "placement.send", connection: "google", dedupe: "blind", risk: "low", reachesPerson: false },
    // A receiving Mailbox's daily report to one Circle member, at that member's own address: the verdicts
    // of the checks it read, signed with its member key. Blind for the same reason.
    { kind: "effect", name: "placement.report", connection: "google", dedupe: "blind", risk: "low", reachesPerson: false },
    // Takes INBOX off a content Placement check this Mailbox received, after its verdict. Blind: reconcile
    // is handed no Message-ID to look it up by.
    { kind: "effect", name: "placement.archive", connection: "google", dedupe: "blind", risk: "low", reachesPerson: false },
    { kind: "trigger", name: "email.received", connection: "google", source: "poll", pollIntervalMs: 60_000 },
    // Headers of Sent mail, for whom the founder already writes to. Never a subject or a body.
    { kind: "trigger", name: "mail.sent", connection: "google", source: "poll", pollIntervalMs: 3_600_000 },
    { kind: "query", name: "mailbox.profile", connection: "google" },
    { kind: "query", name: "mail.from", connection: "google" },
    { kind: "query", name: "mailbox.probe_read", connection: "google" },
    // Where an expected Placement check landed: its labels and Message-ID, found by search, never its body.
    { kind: "query", name: "placement.read", connection: "google" },
  ],
} as const;
