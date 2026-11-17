// SPDX-License-Identifier: AGPL-3.0-only
// Reoon checks addresses for a Workspace with the API key a person typed into the vault. Two reads
// and nothing else: it never sends mail.
export const reoonManifest = {
  id: "com.trydirex.reoon",
  name: "Reoon",
  apiVersion: 1,
  version: "0.1.0",
  minHostVersion: "0.1.0",
  trust: "first_party",
  connections: [{ key: "reoon", auth: "api_key" }],
  egress: { hosts: ["emailverifier.reoon.com"] },
  capabilities: [
    { kind: "query", name: "email.verify", connection: "reoon" },
    { kind: "query", name: "email.verify_balance", connection: "reoon" },
  ],
} as const;
