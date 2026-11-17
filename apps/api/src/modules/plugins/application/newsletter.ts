// SPDX-License-Identifier: AGPL-3.0-only
// What makes a plugin a newsletter provider: three effects and two queries on one connection,
// plus stats when the tool has them, and lists when one account can hold several. Core finds a
// provider from this, never from a plugin's name.
import type { DedupeClass, Manifest } from "@direx/plugin-sdk";
import { PROVIDER_KINDS } from "@direx/plugin-sdk/host";

export const NEWSLETTER_DRAFT = "newsletter.draft";
export const NEWSLETTER_SEND = "newsletter.send";
export const NEWSLETTER_CANCEL = "newsletter.cancel";
export const NEWSLETTER_PUBLISH = "newsletter.publish";
export const NEWSLETTER_SUBSCRIBERS = "newsletter.subscribers";
export const NEWSLETTER_PROFILE = "newsletter.profile";
export const NEWSLETTER_STATS = "newsletter.stats";
export const NEWSLETTER_LISTS = "newsletter.lists";

const NEEDED = PROVIDER_KINDS.newsletter;

/**
 * publishLeadMs: how long before an issue's slot its publish must be called, 0 for a tool that sends at once.
 * hasLists: the account can hold several lists, so a person chooses one before any issue is made.
 */
export type NewsletterShape = { connection: string; sendDedupe: DedupeClass; publishDedupe: DedupeClass; publishLeadMs: number; hasStats: boolean; hasLists: boolean };

/** The manifest's newsletter connections, and what each partly-newsletter connection lacks. */
export function newsletterShapes(m: Manifest): { shapes: NewsletterShape[]; incomplete: { connection: string; missing: string[] }[] } {
  const shapes: NewsletterShape[] = [];
  const incomplete: { connection: string; missing: string[] }[] = [];
  for (const { key: connection } of m.connections) {
    const find = (kind: string, name: string) => m.capabilities.find((c) => c.connection === connection && c.kind === kind && c.name === name);
    const missing = NEEDED.filter(([kind, name]) => !find(kind, name)).map(([, name]) => name);
    if (missing.length === NEEDED.length) continue;
    if (missing.length) {
      incomplete.push({ connection, missing });
      continue;
    }
    const send = find("effect", NEWSLETTER_SEND);
    const publish = find("effect", NEWSLETTER_PUBLISH);
    if (send?.kind === "effect" && publish?.kind === "effect") shapes.push({ connection, sendDedupe: send.dedupe, publishDedupe: publish.dedupe, publishLeadMs: publish.leadMs ?? 0, hasStats: !!find("query", NEWSLETTER_STATS), hasLists: !!find("query", NEWSLETTER_LISTS) });
  }
  return { shapes, incomplete };
}

