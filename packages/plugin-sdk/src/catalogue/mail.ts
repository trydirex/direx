// SPDX-License-Identifier: MIT
// mail.from: recent mail one sender sent to a Mailbox. Direx code calls it with mail to skip; a
// model may call it as an agent query with an address alone, and sees only the view below.
// The two mail triggers core reads by name, email.received and mail.sent, and their event data.
import { z } from "zod";
import type { InputScope } from "./entry";

/**
 * Mail a mailbox poll must not read: sent by `from`, with `subject` in its subject and not
 * `notSubject`, inside the window (epoch ms). The poll finds it by the provider's own search and
 * fetches nothing of it, so it never reaches the host. Added in host 0.2.0.
 */
export type SkipMail = { from: string; subject: string; notSubject?: string | undefined; after: number; before: number };
export const skipMail = z.object({
  from: z.string().min(3).max(320),
  subject: z.string().min(1).max(998),
  notSubject: z.string().min(1).max(998).optional(),
  after: z.number().int().nonnegative(),
  before: z.number().int().nonnegative(),
});

const messageHeaders = z.strictObject({
  from: z.string(),
  subject: z.string(),
  /** As the message says it, possibly empty; Direx reads it with Date.parse. */
  date: z.string(),
  inReplyTo: z.string(),
  references: z.string(),
  to: z.string().optional(),
  cc: z.string().optional(),
  messageId: z.string().optional(),
  /** The topmost Authentication-Results, where the provider has one (Gmail). */
  authenticationResults: z.string().optional(),
});

/**
 * One received message, as a Mailbox's `email.received` trigger hands it over and `mail.from`
 * finds it. Strict on what Direx reads; where the first-party Mailboxes differ, the union, and a
 * field only one of them sends is optional.
 */
const receivedMessage = z.strictObject({
  kind: z.literal("message").optional(),
  /** Gmail's own ids and labels. */
  gmailId: z.string().optional(),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  bounce: z.boolean().optional(),
  /** The Auto-Submitted header, or "auto-replied" for an X-Autoreply; empty or null when neither. */
  autoSubmitted: z.string().nullish(),
  /** Who a delivery notice says failed, with each DSN status; null for any other mail. */
  dsn: z.strictObject({ recipients: z.array(z.strictObject({ email: z.string(), status: z.string().nullable() })) }).nullish(),
  headers: messageHeaders,
  text: z.string(),
});

/** New inbox mail. Core reads it for replies, bounces, opt-outs and Placement mail. */
export const emailReceived = { name: "email.received", version: 1, data: receivedMessage } as const;

/** Mail the account sent, headers only: whom the founder already writes to. */
export const mailSent = {
  name: "mail.sent",
  version: 1,
  data: z.strictObject({
    messageId: z.string().max(998),
    recipients: z.array(z.string().max(320)).max(1000),
    /** Epoch ms. */
    sentAt: z.number(),
    xDirexAction: z.string().nullable(),
    listUnsubscribe: z.string().nullable(),
    precedence: z.string().nullable(),
  }),
} as const;

const MAX_MESSAGES = 10;
const clip = (s: string, n: number) => [...s].slice(0, n).join("");
// The fields the view shows, read from the received message's own schemas; a message without them is left out.
const message = z.object({
  bounce: receivedMessage.shape.bounce,
  headers: z.object({ from: messageHeaders.shape.from, subject: messageHeaders.shape.subject, date: messageHeaders.shape.date }),
  text: receivedMessage.shape.text,
});

const output = z.strictObject({ events: z.array(z.strictObject({ eventId: z.string(), data: z.unknown() })) });
type MailFromWire = z.infer<typeof output>;
type MailFromView = { messages: { from: string; date: string; subject: string; excerpt: string }[] };

export const mailFrom = {
  name: "mail.from",
  version: 1,
  // An address a provider's search can take, as the first-party Mailboxes check it.
  input: z.strictObject({ email: z.string().max(320).regex(/^[^\s"():{}]+@[^\s"():{}]+$/), skip: z.array(skipMail).max(500).optional() }),
  output,
  agent: {
    description:
      "Recent email that one sender sent to this Workspace's Mailboxes: sender, date, subject and the start of each message, newest first. Give the email address of a person already in this task.",
    input: z.strictObject({ email: z.email() }),
    scope: "person_address_in_run" as InputScope,
    view: ({ events }: MailFromWire): MailFromView => {
      const messages = events.flatMap((e) => {
        const m = message.safeParse(e.data);
        return m.success && !m.data.bounce ? [m.data] : [];
      });
      const when = (d: string) => Date.parse(d) || 0;
      messages.sort((a, b) => when(b.headers.date) - when(a.headers.date));
      return {
        messages: messages.slice(0, MAX_MESSAGES).map((m) => ({
          from: clip(m.headers.from, 200),
          date: clip(m.headers.date, 50),
          subject: clip(m.headers.subject, 200),
          excerpt: clip(m.text, 1000),
        })),
      };
    },
  },
} as const;
