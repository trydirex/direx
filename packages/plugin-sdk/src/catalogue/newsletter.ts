// SPDX-License-Identifier: MIT
// What a newsletter tool answers, whichever tool it is: its subscribers, the list's name and size,
// an issue's numbers and, for an account that holds several, its lists. Then the effects that write,
// send, publish and cancel an issue; a send acts only on an issue id that a draft returned.
import { z } from "zod";
import { noInput } from "./entry";
import { noLineBreak } from "./message";

const time = z.iso.datetime({ offset: true });
const count = z.number().int().min(0);
/** One list inside an account that holds several, such as a Mailchimp audience. Tools with one list ignore it. */
const listId = z.string().min(1).max(100);

/** A tool's own state names map to these; anything a plugin doesn't list is "other", never "subscribed". */
const SUBSCRIBER_STATES = ["subscribed", "unsubscribed", "bounced", "complained", "other"] as const;
const subscriber = z.strictObject({ email: z.string().min(3).max(320), state: z.enum(SUBSCRIBER_STATES), createdAt: time, updatedAt: time.optional() });

export const newsletterSubscribers = {
  name: "newsletter.subscribers",
  version: 1,
  input: z.strictObject({ cursor: z.string().min(1).optional(), changedSince: time.optional(), listId: listId.optional() }),
  output: z.strictObject({ subscribers: z.array(subscriber), nextCursor: z.string().min(1).nullable() }),
} as const;

export const newsletterProfile = {
  name: "newsletter.profile",
  version: 1,
  input: z.strictObject({ listId: listId.optional() }).nullish(),
  output: z.strictObject({ listName: z.string(), subscriberCount: count, canSend: z.boolean() }),
} as const;

export const newsletterStats = {
  name: "newsletter.stats",
  version: 1,
  input: z.strictObject({ issueId: z.string().min(1).max(200) }),
  /** Opens are kept but never trusted on their own: many are recorded automatically by mail apps. */
  output: z.strictObject({ recipients: count, delivered: count.optional(), clicks: count, unsubscribes: count, opens: count }),
} as const;

/** The lists an account holds, for a person to choose one. Only tools with several lists answer this. */
export const newsletterLists = {
  name: "newsletter.lists",
  version: 1,
  input: noInput,
  output: z.array(z.strictObject({ id: listId, name: z.string(), subscriberCount: count })),
} as const;

const issueId = z.string().min(1).max(200);
const draftInput = z.strictObject({
  title: noLineBreak.pipe(z.string().min(1).max(998)),
  previewText: noLineBreak.pipe(z.string().max(500)).optional(),
  html: z.string().min(1).max(1_000_000),
  listId: listId.optional(),
});

export const newsletterDraft = { name: "newsletter.draft", version: 1, input: draftInput } as const;
/** Without `at` the issue goes now, or as soon as the tool allows. */
export const newsletterSend = { name: "newsletter.send", version: 1, input: z.strictObject({ issueId, at: time.optional() }) } as const;
export const newsletterCancel = { name: "newsletter.cancel", version: 1, input: z.strictObject({ issueId }) } as const;

/**
 * An issue written and sent in one step: one approval, one Action. Without `at` it goes as soon as the
 * tool allows. `audience` names the list for Direx's own checks, and `markdown` is what the person
 * wrote before Direx rendered it to `html`; the plugin reads neither. Direx reads the spec back to hand
 * an issue over to be sent by hand.
 */
export const newsletterPublish = {
  name: "newsletter.publish",
  version: 1,
  input: draftInput.extend({ at: time.optional(), audience: z.unknown().optional(), markdown: z.string().max(1_000_000).optional() }),
  spec: z.looseObject({
    title: z.string(),
    previewText: z.string().optional(),
    html: z.string(),
    markdown: z.string().optional(),
    at: z.string().optional(),
    listId: z.string().optional(),
    audience: z.unknown().optional(),
  }),
} as const;
