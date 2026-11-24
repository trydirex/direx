// SPDX-License-Identifier: AGPL-3.0-only
// The tracking module's only public entry point (ADR 0035): a Workspace's tracking domains, and the
// edge's question about them, served on an internal port, links rewritten in a step's email, and the
// public redirect that counts their clicks.
export { systemDns, type DnsLookup } from "./adapters/dns";
export { createTrackingDomains, type TrackingDomains } from "./application/domains";
export { fixLinks, fixLinksIn, recordUses, recordUsesOf, trackedDestination, type FixedLinks, type TrackingInput } from "./application/links";
export { createRedirect, type Redirect } from "./application/redirect";
export { trackingAskApp, trackingRedirectApp, trackingRoutes } from "./routes";

import { createHash } from "node:crypto";
import { rewriteLinks } from "./domain/rewrite";
import { campaignTracking, countryOf, type TrackingTx } from "./adapters/repo";
import { inputsHash } from "./application/links";

/** The current inputs of a tracked email, without rewriting its approved text or creating links. */
export async function currentEmailTrackingHash(tx: TrackingTx, campaignId: string, personId: string) {
  const t = await campaignTracking(tx, campaignId);
  if (!t?.trackingOn || !t.domainId || (t.state !== "dns_ok" && t.state !== "verified")) return null;
  const who = await countryOf(tx, personId);
  return inputsHash({ perPerson: t.perPersonOn, marked: false, country: who?.country ?? null, confidence: who?.confidence ?? null, domainId: t.domainId });
}

/** Tracked links actually present in the fixed message. Older revisions' uses can still exist. */
export function trackingLinksInText(text: string) {
  return rewriteLinks(text, () => null).destinations.flatMap((destination) => {
    const url = new URL(destination);
    const parts = /^\/t\/([A-Za-z0-9_-]{22})(?:\/([A-Za-z0-9_-]{43}))?$/.exec(url.pathname);
    return parts ? [{ hostname: url.hostname, linkId: parts[1]!, tokenHash: parts[2] ? createHash("sha256").update(parts[2]).digest("hex") : null }] : [];
  });
}
