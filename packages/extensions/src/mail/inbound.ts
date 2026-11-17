// SPDX-License-Identifier: AGPL-3.0-only
// What every mail plugin agrees on when reading a message: how much text to keep, what counts as a
// bounce, and who a delivery notice says failed.
export const TEXT_CHARS = 5_000;
export const MAX_DECODE_BYTES = 200_000;

const BOUNCE_SENDERS = ["mailer-daemon", "postmaster"];
const BOUNCE_SUBJECTS = [
  "delivery status notification",
  "undeliverable",
  "undelivered mail",
  "mail delivery failed",
  "delivery failure",
  "returned mail",
  "failure notice",
];

export function isBounce(from: string, subject: string): boolean {
  const f = from.toLowerCase();
  const s = subject.toLowerCase();
  return BOUNCE_SENDERS.some((x) => f.includes(x)) || BOUNCE_SUBJECTS.some((x) => s.includes(x));
}

export type Dsn = { recipients: { email: string; status: string | null }[] };

/** The recipients named in the text of a delivery-status part. */
export function dsnRecipients(text: string): Dsn["recipients"] {
  return text.split(/\r?\n\s*\r?\n/).flatMap((block) => {
    const email = /^Final-Recipient:\s*(?:rfc822;)?\s*(\S+)/im.exec(block)?.[1];
    return email ? [{ email: email.toLowerCase(), status: /^Status:\s*([245]\.\d+\.\d+)/im.exec(block)?.[1] ?? null }] : [];
  });
}

/** The X-Failed-Recipients header, for a bounce with no delivery-status part. */
export function failedRecipients(header: string): Dsn["recipients"] {
  return header.split(",").map((email) => ({ email: email.trim().toLowerCase(), status: null }));
}
