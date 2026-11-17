// SPDX-License-Identifier: AGPL-3.0-only
// Reading Sent mail, for knowing whom the founder already writes to. Metadata only: the six
// headers below, never a subject or a body. The first poll reads the last 90 days; later polls read
// since the last sweep, with a day's overlap the host's seen-event check absorbs. A sweep that runs
// out of time keeps its page token in the cursor and carries on at the next poll.
import type { TriggerData } from "@direx/plugin-sdk";
import { GmailError, headerOf, type GmailClient } from "./client";

export const SENT_HEADERS = ["To", "Cc", "Message-ID", "X-Direx-Action", "List-Unsubscribe", "Precedence"];
export const LOOKBACK_DAYS = 90;
const DAY_S = 86_400;
const PAGE = 100;
const PARALLEL = 10;
/** Under the host's 25 s call timeout, with room for the last page. */
export const SWEEP_BUDGET_MS = 12_000;

type Cursor = { since: number; top?: number; pageToken?: string };

function parseCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<Cursor>;
    return typeof c.since === "number" ? (c as Cursor) : null;
  } catch {
    return null;
  }
}

type SentEvent = { eventId: string; data: TriggerData<"mail.sent"> };
// The mail.sent entry's bounds: a longer Message-ID or address is not a real one, and mail to
// more people than this is crowd mail however many more there are.
const MAX_ID = 998;
const MAX_ADDRESS = 320;
const MAX_RECIPIENTS = 1000;

/** Every address in a To or Cc header, lowercased. A group with no members yields none. */
export function addressesIn(...headers: string[]): string[] {
  const found = headers.join(",").toLowerCase().match(/[^\s<>,;:"()]+@[^\s<>,;:"()]+/g) ?? [];
  return [...new Set(found)].filter((a) => a.length <= MAX_ADDRESS).slice(0, MAX_RECIPIENTS);
}

export async function pollSent(
  client: GmailClient,
  token: string,
  rawCursor: string | null,
  now: number,
  budgetMs = SWEEP_BUDGET_MS,
): Promise<{ events: SentEvent[]; cursor: string }> {
  const startedAt = performance.now();
  const c = parseCursor(rawCursor) ?? { since: Math.floor(now / 1000) - LOOKBACK_DAYS * DAY_S };
  const top = c.top ?? Math.floor(now / 1000);
  let pageToken = c.pageToken;
  const events: SentEvent[] = [];
  for (;;) {
    let listing;
    try {
      listing = await client.list(token, { q: `in:sent after:${c.since}`, maxResults: PAGE, pageToken });
    } catch (e) {
      // A page token Gmail no longer takes starts the sweep over; the seen-event check drops repeats.
      if (pageToken && e instanceof GmailError && e.status === 400) {
        pageToken = undefined;
        continue;
      }
      throw e;
    }
    const ids = (listing?.messages ?? []).map((m) => m.id);
    for (let i = 0; i < ids.length; i += PARALLEL) {
      const got = await Promise.all(ids.slice(i, i + PARALLEL).map((id) => client.message(token, id, "metadata", SENT_HEADERS)));
      for (const m of got) {
        if (!m) continue; // deleted since the listing
        const h = (name: string) => headerOf(m, name) ?? null;
        events.push({
          eventId: m.id,
          data: {
            // An over-long Message-ID reads as none, as a message without one does.
            messageId: (h("Message-ID") ?? "").length > MAX_ID ? "" : (h("Message-ID") ?? ""),
            recipients: addressesIn(h("To") ?? "", h("Cc") ?? ""),
            sentAt: Number(m.internalDate ?? now),
            xDirexAction: h("X-Direx-Action"),
            listUnsubscribe: h("List-Unsubscribe"),
            precedence: h("Precedence"),
          },
        });
      }
    }
    if (!listing?.nextPageToken) return { events, cursor: JSON.stringify({ since: top - DAY_S }) };
    pageToken = listing.nextPageToken;
    if (performance.now() - startedAt > budgetMs) return { events, cursor: JSON.stringify({ since: c.since, top, pageToken }) };
  }
}
