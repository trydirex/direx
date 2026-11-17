// SPDX-License-Identifier: AGPL-3.0-only
// Pure: the opt-out every cold or marketing email ends with. A reply is the opt-out that always works,
// since replies are read for it on every Mailbox; the link and one-click header only work when the
// recipient's mail client can reach Direx over HTTPS, so they are added only then.
export const REPLY_STOP = `Reply "stop" and I won't email you again.`;

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^0\./];

/** Whether a mail client anywhere could open this address: HTTPS, and not a local or private host. */
export function isPublicHttps(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return !PRIVATE_V4.some((r) => r.test(host));
  if (host.includes(":")) return !(host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host));
  return host.includes(".");
}

/** The footer, the same for a cold email and for the probe that tests a Mailbox. */
export function optOutFooter(a: { senderName: string; postalAddress: string; unsubscribeUrl: string | null }): string {
  return `--\n${a.senderName}\n${a.postalAddress}\n${REPLY_STOP}${a.unsubscribeUrl ? `\nUnsubscribe: ${a.unsubscribeUrl}` : ""}`;
}
