// SPDX-License-Identifier: AGPL-3.0-only
// Manual check of the Gmail plugin against a real mailbox. Sends exactly one message,
// then answers three questions: which address is connected, which Message-ID Gmail
// stored (it replaces any we set), and does reconcile find the message by our
// X-Direx-Action header. Get a one-hour access token for the gmail.modify scope from
// Google's OAuth Playground; it is read from the environment and never printed.
//
//   DIREX_GMAIL_SMOKE_TOKEN=... DIREX_GMAIL_SMOKE_TO=you@example.com bun scripts/gmail-smoke.ts
import { createGmailPlugin } from "@direx/extensions";

const token = process.env.DIREX_GMAIL_SMOKE_TOKEN;
const to = process.env.DIREX_GMAIL_SMOKE_TO;
if (!token || !to) {
  console.error("gmail-smoke: set DIREX_GMAIL_SMOKE_TOKEN (an access token) and DIREX_GMAIL_SMOKE_TO (where to send)");
  process.exit(2);
}

const plugin = createGmailPlugin();
const actionId = crypto.randomUUID();
const ctx = { workspaceId: "00000000-0000-4000-8000-000000000000", idempotencyKey: actionId, credential: { accessToken: token, expiresAt: "" }, log: () => {} };
const send = plugin.effects["email.send"]!;

const profile = (await plugin.queries["mailbox.profile"]!({}, ctx)) as { emailAddress: string | null };
console.log(`connected as:            ${profile.emailAddress}`);

const { spec } = await send.prepare({ to: [to], subject: `Direx smoke test ${new Date().toISOString()}`, text: "One test message from the Direx Gmail plugin." }, ctx);
const sent = await send.execute(spec, ctx);
if (sent.kind !== "sent") {
  console.log(`send:                    refused (${sent.detail})`);
  process.exit(1);
}
console.log(`send:                    sent, Gmail id ${sent.providerRef}`);
console.log(`Message-ID from Gmail:   ${sent.correlationKey ?? "could not be read back"}`);

const found = await send.reconcile!("", ctx);
console.log(`reconcile finds it:      ${found.kind === "sent" ? `yes (${found.providerRef})` : "no"}`);
