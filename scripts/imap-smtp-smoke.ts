// SPDX-License-Identifier: AGPL-3.0-only
// Manual check of the password Mailbox plugin against a real mail service. Sends exactly one
// message, then answers what each service does with it: does it keep a Sent copy, and do our
// Message-ID and X-Direx-Action header survive. The password is read from the environment and
// never printed.
//
//   DIREX_MAIL_SMOKE_SETTINGS='{"fromAddress":"me@example.com","smtpHost":"smtp.example.com","smtpPort":"465","imapHost":"imap.example.com","imapPort":"993"}' \
//   DIREX_MAIL_SMOKE_PASSWORD=... DIREX_MAIL_SMOKE_TO=you@example.com bun scripts/imap-smtp-smoke.ts
import { createImapSmtpPlugin } from "@direx/extensions";

const rawSettings = process.env.DIREX_MAIL_SMOKE_SETTINGS;
const password = process.env.DIREX_MAIL_SMOKE_PASSWORD;
const to = process.env.DIREX_MAIL_SMOKE_TO;
if (!rawSettings || !password || !to) {
  console.error("imap-smtp-smoke: set DIREX_MAIL_SMOKE_SETTINGS (JSON), DIREX_MAIL_SMOKE_PASSWORD and DIREX_MAIL_SMOKE_TO (where to send)");
  process.exit(2);
}

const settings = JSON.parse(rawSettings) as Record<string, string>;
const plugin = createImapSmtpPlugin();
const actionId = crypto.randomUUID();
const credential = { username: settings.username ?? settings.fromAddress ?? "", password, settings };
const ctx = { workspaceId: "00000000-0000-4000-8000-000000000000", idempotencyKey: actionId, credential, log: () => {} };
const send = plugin.effects["email.send"]!;

const profile = (await plugin.queries["mailbox.profile"]!({}, ctx)) as { emailAddress: string; hasSent: boolean };
console.log(`connected as:             ${profile.emailAddress}`);
console.log(`Sent folder found:        ${profile.hasSent ? "yes" : "no"}`);

const { spec } = await send.prepare({ to: [to], subject: `Direx smoke test ${new Date().toISOString()}`, text: "One test message from the Direx password Mailbox plugin." }, ctx);
const sent = await send.execute(spec, ctx);
if (sent.kind !== "sent") {
  console.log(`send:                     refused (${sent.detail})`);
  process.exit(1);
}
console.log(`send:                     sent, Message-ID ${sent.correlationKey}`);

// A Sent copy can take a moment to appear.
let found = await send.reconcile!("", ctx);
for (let i = 0; i < 5 && found.kind !== "sent"; i++) {
  await Bun.sleep(3000);
  found = await send.reconcile!("", ctx);
}
const stored = found.kind === "sent" ? found.providerRef : undefined;
console.log(`Sent copy with our header: ${stored ? "yes" : "no: this service keeps no copy, or dropped the X-Direx-Action header"}`);
if (stored) console.log(`Message-ID kept:          ${stored === sent.correlationKey ? "yes" : `no, stored as ${stored}`}`);
process.exit(0);
