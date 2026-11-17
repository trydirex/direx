// SPDX-License-Identifier: MIT
// The message every Mailbox sends: what Direx passes to prepare for an email, a Mailbox check or
// Placement mail, and the fields it reads back from the approved spec. A plugin's spec carries more
// (a multipart boundary, a thread); those stay the plugin's own.
import { z } from "zod";

/** A header value: one line, since a line break would start a header of its own. */
export const noLineBreak = z.string().refine((s) => !/[\r\n]/.test(s), "line breaks are not allowed in a header");
// ponytail: a plain shape check, not full RFC 5321; the provider refuses the rest.
const address = z.string().regex(/^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/, "not an email address");
const recipient = z.union([address, z.strictObject({ name: noLineBreak.pipe(z.string().max(200)), address })]);
const msgId = noLineBreak.pipe(z.string().regex(/^<[^<>\s]+>$/, "a message id such as <id@example.com>"));

/** What Direx passes to prepare for a message. */
export const message = z.strictObject({
  to: z.array(recipient).min(1, "at least one recipient").max(50),
  cc: z.array(recipient).max(50).optional(),
  subject: noLineBreak.pipe(z.string().max(998)),
  text: z.string().max(500_000),
  html: z.string().max(1_000_000).optional(),
  inReplyTo: msgId.optional(),
  references: z.array(msgId).max(100).optional(),
  /** One-click unsubscribe (RFC 8058): the URL takes a POST with no sign-in. */
  listUnsubscribe: noLineBreak.pipe(z.url({ protocol: /^https?$/ })).refine((u) => !/[<>]/.test(u), "not a URL").optional(),
});

export const TOUCH_CLASSES = ["cold", "sales_follow_up", "reply_in_thread", "service", "transactional", "consented_marketing"] as const;

/**
 * The Touch Direx adds to an email's approved spec after prepare: whom it reaches and in which class.
 * Touch caps and suppression read it. A plugin takes it in the spec and reads none of it.
 */
export const touch = z.strictObject({
  personId: z.uuid(),
  touchClass: z.enum(TOUCH_CLASSES),
  /** Set on a cold email written to someone on a newsletter list, so approving it is a person's yes to that. */
  newsletterSubscriber: z.literal(true).optional(),
});

/** A recipient as Direx reads it back: an address, or one with a name. */
const readRecipient = z.union([z.string(), z.looseObject({ address: z.string() })]);
/** The fields Direx reads from a message's approved spec. */
const messageSpec = z.looseObject({
  to: z.array(readRecipient),
  cc: z.array(readRecipient).optional(),
  subject: z.string(),
  text: z.string(),
  listUnsubscribe: z.string().optional(),
  touch: touch.optional(),
});

/** An email to a Person. */
export const emailSend = { name: "email.send", version: 1, input: message, spec: messageSpec } as const;
/** The Mailbox writing to itself on connect, sent exactly as an email is. */
export const mailboxProbe = { name: "mailbox.probe", version: 1, input: message, spec: messageSpec } as const;
/** Placement mail: the reply that joins the circle, a check and the daily report. */
export const placementJoin = { name: "placement.join", version: 1, input: message, spec: messageSpec } as const;
export const placementSend = { name: "placement.send", version: 1, input: message, spec: messageSpec } as const;
export const placementReport = { name: "placement.report", version: 1, input: message, spec: messageSpec } as const;
/** Takes one received Placement check out of the inbox, found by its Message-ID. */
export const placementArchive = {
  name: "placement.archive",
  version: 1,
  input: z.strictObject({ messageId: z.string().regex(/^<([^\s"():{}<>]+)>$/, "one Message-ID in angle brackets") }),
} as const;
