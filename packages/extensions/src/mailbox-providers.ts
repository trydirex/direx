// SPDX-License-Identifier: AGPL-3.0-only
// What the connect screen shows for each mailbox provider, so the web app holds no provider names.
// A plugin's capabilities are in its manifest; this is only how a person connects it.
export type MailboxProviderInfo = {
  connection: string;
  /** The words on the connect button. */
  label: string;
  /** "oauth" opens the provider's consent page; "form" asks for the fields below. */
  connect: "oauth" | "form";
  deployments: readonly ("cloud" | "self_host")[];
  fields?: { name: string; label: string; optional?: boolean }[];
  presets?: { label: string; values: Record<string, string> }[];
};

const server = (smtpHost: string, smtpPort: string, imapHost: string) => ({ smtpHost, smtpPort, imapHost, imapPort: "993" });

export const mailboxProviders = (): readonly MailboxProviderInfo[] => [
  { connection: "google", label: "Connect a Gmail account", connect: "oauth", deployments: ["cloud", "self_host"] },
  {
    connection: "imap_smtp",
    label: "Connect an email account with a password",
    connect: "form",
    // Cloud would connect to whatever host a customer typed, so it stays with OAuth providers.
    deployments: ["self_host"],
    fields: [
      { name: "fromAddress", label: "Email address" },
      { name: "fromName", label: "Sender name", optional: true },
      { name: "smtpHost", label: "Sending server" },
      { name: "smtpPort", label: "Sending port" },
      { name: "imapHost", label: "Reading server" },
      { name: "imapPort", label: "Reading port" },
    ],
    presets: [
      { label: "Gmail (app password)", values: server("smtp.gmail.com", "465", "imap.gmail.com") },
      { label: "iCloud Mail", values: server("smtp.mail.me.com", "587", "imap.mail.me.com") },
      { label: "Fastmail", values: server("smtp.fastmail.com", "465", "imap.fastmail.com") },
      { label: "Yahoo Mail", values: server("smtp.mail.yahoo.com", "465", "imap.mail.yahoo.com") },
    ],
  },
];
