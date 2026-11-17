// SPDX-License-Identifier: AGPL-3.0-only
// What makes a plugin a mailbox provider: the SDK's four capabilities on one connection. Core finds a
// provider from this, never from a plugin's name.
import type { DedupeClass, Manifest } from "@direx/plugin-sdk";
import { PROVIDER_KINDS } from "@direx/plugin-sdk/host";

export const EMAIL_SEND = "email.send";
export const EMAIL_RECEIVED = "email.received";
export const MAILBOX_PROFILE = "mailbox.profile";
export const MAIL_FROM = "mail.from";
/** Optional: a test message to the Mailbox's own address, and reading it back as delivered. */
export const MAILBOX_PROBE = "mailbox.probe";
export const MAILBOX_PROBE_READ = "mailbox.probe_read";
/** Optional poll trigger: headers of mail the account sent, for whom it already writes to. */
export const MAIL_SENT = "mail.sent";

/**
 * Placement circle mail: checks to other circle members, reports, join replies and archiving.
 * Core alone decides these reach no Person, and only for plugins loaded in core; a manifest's
 * own reachesPerson is ignored for any `placement.` effect.
 */
export const PLACEMENT_EFFECTS: ReadonlySet<string> = new Set(["placement.send", "placement.report", "placement.join", "placement.archive"]);
/** The reply that asks to join the Placement circle. */
export const PLACEMENT_JOIN = "placement.join";
/** A Placement check to another Circle member. */
export const PLACEMENT_SEND = "placement.send";
/** A receiving Mailbox's daily report of the checks it read, to their sender. */
export const PLACEMENT_REPORT = "placement.report";
/** Takes a received content Placement check out of the inbox after its verdict. */
export const PLACEMENT_ARCHIVE = "placement.archive";
/** Optional query: where an expected Placement check landed, by its labels alone. */
export const PLACEMENT_READ = "placement.read";

/** Whether an effect reaches a Person, from core's rules rather than the manifest alone. */
export function reachesPerson(name: string, declared: boolean, inCore: boolean): boolean {
  if (name.startsWith("placement.")) return !(inCore && PLACEMENT_EFFECTS.has(name));
  return inCore ? declared : true;
}

const NEEDED = PROVIDER_KINDS.mailbox;

export type MailboxShape = { connection: string; dedupe: DedupeClass };

/** The manifest's mailbox connections, and what each partly-mailbox connection lacks. */
export function mailboxShapes(m: Manifest): { shapes: MailboxShape[]; incomplete: { connection: string; missing: string[] }[] } {
  const shapes: MailboxShape[] = [];
  const incomplete: { connection: string; missing: string[] }[] = [];
  for (const { key: connection } of m.connections) {
    const has = (kind: string, name: string) => m.capabilities.some((c) => c.connection === connection && c.kind === kind && c.name === name);
    const missing = NEEDED.filter(([kind, name]) => !has(kind, name)).map(([, name]) => name);
    if (missing.length === NEEDED.length) continue;
    if (missing.length) {
      incomplete.push({ connection, missing });
      continue;
    }
    const send = m.capabilities.find((c) => c.connection === connection && c.kind === "effect" && c.name === EMAIL_SEND);
    if (send?.kind === "effect") shapes.push({ connection, dedupe: send.dedupe });
  }
  return { shapes, incomplete };
}
