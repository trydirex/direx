// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what a click on a tracked link counts as, and whether it counts at all (ADR 0035 rules 005,
// 010 and 017). Mail scanners and link-preview fetchers open links no person clicked, so their clicks
// are kept apart as likely automatic, never dropped: nothing is deduplicated.

export type Bucket = "automatic" | "rest";

/** Bumped whenever FETCHER_LIST or the rules below change; each count records the version that sorted it. */
export const CLASSIFIER_VERSION = 1;

/** User agents of fetchers that open links without a person: previews, mail security scanners, HTTP libraries. */
export const FETCHER_LIST: readonly RegExp[] = [
  /bot\b|crawler|spider|preview|externalhit/i,
  /slack|discord|telegram|whatsapp|skypeuri|linkedin|mastodon|pleroma|misskey|cardyb/i,
  /barracuda|mimecast|proofpoint|symantec|forcepoint|trendmicro|safelinks|googleimageproxy|yahoomailproxy/i,
  /^(curl|wget|python-requests|python-urllib|go-http-client|okhttp|java|libwww-perl|axios|node-fetch|undici)\b/i,
  /headlesschrome|phantomjs/i,
];

/** A token click this soon after its Action went out is a scanner opening the mail, not its reader. */
export const TOKEN_WINDOW_MS = 60_000;
/** Requests per link per minute that count; more still redirect (rule 005). */
export const PER_MINUTE = 120;
/** A link counts for 12 months after its message is sent, and redirects for as long as the Workspace lives. */
export const COUNTING_MONTHS = 12;

/**
 * HEAD, a fetcher's user agent, no user agent at all, or a token click within a minute of its
 * Action's send is likely automatic; every other GET is the rest.
 */
export function classify(c: { method: string; userAgent: string | null; tokenSentAt: Date | null; now: Date }): Bucket {
  if (c.method !== "GET" || !c.userAgent?.trim()) return "automatic";
  if (FETCHER_LIST.some((f) => f.test(c.userAgent!))) return "automatic";
  if (c.tokenSentAt && c.now.getTime() - c.tokenSentAt.getTime() < TOKEN_WINDOW_MS) return "automatic";
  return "rest";
}

/** Whether counting is over: the last send it rests on was more than 12 months ago. Unsent counts on. */
export function countingEnded(lastSentAt: Date | null, now: Date): boolean {
  if (!lastSentAt) return false;
  const ends = new Date(lastSentAt);
  ends.setUTCMonth(ends.getUTCMonth() + COUNTING_MONTHS);
  return now >= ends;
}
