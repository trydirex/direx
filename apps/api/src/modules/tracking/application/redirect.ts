// SPDX-License-Identifier: AGPL-3.0-only
// Following a tracked link (ADR 0035 rules 004 to 006, 009, 010, 017 and 021). The host and link find
// the Workspace through one system function; everything else is read and counted inside that
// Workspace. The request's headers are read in memory to classify the click and never stored.
import { createHash } from "node:crypto";
import { addClick, bumpCounter, inWorkspace, linkToFollow, lookupLink, pruneCounters } from "../adapters/repo";
import { CLASSIFIER_VERSION, classify, countingEnded, PER_MINUTE } from "../domain/classify";

const LINK_ID = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MINUTE_MS = 60_000;
const KEEP_MS = 10 * MINUTE_MS;
// Once approved, an Action's message may go out: its links answer from then on. A held or cancelled
// one was never sent, so its links stay 404.
const LIVE = new Set(["scheduled", "claimed", "dispatching", "sent"]);

export type Click = { host: string; linkId: string; token: string | null; method: string; userAgent: string | null };

const latest = (dates: (Date | null)[]): Date | null => (dates.some((d) => d === null) ? null : dates.reduce<Date | null>((a, d) => (!a || d! > a ? d : a), null));

/** The destination to send this click to, or null for 404. Counts it unless counting is over or this minute's limit is spent. */
export function createRedirect(d: { now?: () => Date } = {}) {
  const now = d.now ?? (() => new Date());
  return async function follow(c: Click): Promise<string | null> {
    if (!LINK_ID.test(c.linkId) || (c.token !== null && !TOKEN.test(c.token))) return null;
    const hostname = c.host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
    const found = await lookupLink(hostname, c.linkId, c.token && createHash("sha256").update(c.token).digest("hex"));
    if (!found) return null;
    const at = now();
    return inWorkspace(found.workspaceId, async (tx) => {
      const link = await linkToFollow(tx, found.linkId, found.useId);
      const live = link?.uses.filter((u) => u.dmId !== null || LIVE.has(u.actionState ?? "")) ?? [];
      if (!link || !live.length) return null;
      // A token's window is its own message's; a shared link counts while any live message's is open.
      const sent = live.map((u) => u.actionSentAt ?? u.dmSentAt);
      if (!link.checkOnly && link.trackingOn && !countingEnded(latest(sent), at)) {
        const minute = new Date(Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS);
        await pruneCounters(tx, new Date(minute.getTime() - KEEP_MS));
        if ((await bumpCounter(tx, found.workspaceId, found.linkId, minute)) <= PER_MINUTE) {
          const bucket = classify({ method: c.method, userAgent: c.userAgent, tokenSentAt: found.useId ? (sent[0] ?? null) : null, now: at });
          await addClick(tx, { workspaceId: found.workspaceId, linkId: found.linkId, day: at.toISOString().slice(0, 10), bucket, classifierVersion: CLASSIFIER_VERSION });
        }
      }
      return link.destination;
    });
  };
}
export type Redirect = ReturnType<typeof createRedirect>;
