// SPDX-License-Identifier: AGPL-3.0-only
// What every newsletter plugin takes and returns, whichever tool sits behind it. A send acts only on
// an issue id that a draft returned, so a retry can always ask the tool what became of that issue.
import { effectSchemas, querySchemas } from "@direx/plugin-sdk";
import { z } from "zod";

const issueId = z.string().min(1).max(200);
const time = z.iso.datetime({ offset: true });

// The effect inputs are the SDK catalogue's (ADR 0028 rule 001); what each tool answers stays here.
export const draftInput = effectSchemas("newsletter.draft").input;
export const draftOutput = z.strictObject({ issueId });
export const publishInput = effectSchemas("newsletter.publish").input;
export const sendInput = effectSchemas("newsletter.send").input;
export const sendOutput = z.strictObject({ issueId, state: z.enum(["sent", "scheduled"]), sendAt: time.optional() });
export const cancelInput = effectSchemas("newsletter.cancel").input;
export const cancelOutput = z.strictObject({ issueId, cancelled: z.boolean(), reason: z.enum(["already_sent"]).optional() });

// The query shapes are the SDK catalogue's too.
const subscribers = querySchemas("newsletter.subscribers");
export const { input: subscribersInput, output: subscribersOutput } = subscribers;
export const subscriber = subscribersOutput.shape.subscribers.element;
export const subscriberState = subscriber.shape.state;
export type SubscriberState = z.infer<typeof subscriberState>;

/**
 * Turns a tool's own state name into one of ours. Only names the plugin lists are mapped; anything
 * else is "other", never "subscribed", so a new state can't quietly count as consent.
 */
export const toSubscriberState = (raw: string, map: Readonly<Record<string, SubscriberState>>): SubscriberState =>
  Object.hasOwn(map, raw) ? map[raw]! : "other";

export const { input: profileInput, output: profileOutput } = querySchemas("newsletter.profile");
export const listsOutput = querySchemas("newsletter.lists").output;
export const statsOutput = querySchemas("newsletter.stats").output;
