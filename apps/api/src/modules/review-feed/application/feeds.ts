// SPDX-License-Identifier: AGPL-3.0-only
// A member's review feed: make or rotate its link, change its settings, stop it, and serve it.
// The link takes no sign-in, so every read checks the token, the membership and the permission.
import { createHash, randomBytes } from "node:crypto";
import { can, memberOf } from "../../identity/index";
import { deleteFeed, feedByHash, feedOf, inWorkspace, recordFetch, updateSettings, upsertFeed } from "../adapters/repo";
import { reviewIcs, type FeedSettings } from "../domain/ics";
import { reviewBlocks } from "./blocks";

/** How much waits in a Workspace's Needs you and when the next one is due. */
export type Waiting = (workspaceId: string) => Promise<{ count: number; nextDeadline: Date | null }>;
export type FeedView = FeedSettings & { createdAt: Date; lastFetchedAt: Date | null; fetchCount: number };

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export function createReviewFeeds(deps: { waiting: Waiting; baseUrl: () => string; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  return {
    async read(workspaceId: string, userId: string): Promise<FeedView | null> {
      const r = await inWorkspace(workspaceId, (tx) => feedOf(tx, userId));
      return r ? { weekdays: r.weekdays, startMinute: r.startMinute, lengthMinutes: r.lengthMinutes, timeZone: r.timeZone, createdAt: r.createdAt, lastFetchedAt: r.lastFetchedAt, fetchCount: r.fetchCount } : null;
    },

    /** Makes the feed, or replaces its link; the old link stops at once. The URL is only ever returned here. */
    async makeLink(workspaceId: string, userId: string, settings: FeedSettings): Promise<string> {
      const token = randomBytes(32).toString("hex");
      await inWorkspace(workspaceId, (tx) => upsertFeed(tx, { workspaceId, userId, tokenHash: hash(token), settings, now: now() }));
      return `${deps.baseUrl()}/api/feeds/review/${workspaceId}/${token}.ics`;
    },

    updateSettings: (workspaceId: string, userId: string, settings: FeedSettings) => inWorkspace(workspaceId, (tx) => updateSettings(tx, userId, settings)),
    stop: (workspaceId: string, userId: string) => inWorkspace(workspaceId, (tx) => deleteFeed(tx, userId)),

    /** The feed's text, or null for a wrong token or a member who may no longer approve. */
    async icsFor(workspaceId: string, token: string): Promise<string | null> {
      const row = await inWorkspace(workspaceId, (tx) => feedByHash(tx, hash(token)));
      if (!row) return null;
      const member = await memberOf(workspaceId, row.userId);
      if (!member || !can(member.role, "item.approve")) return null;
      const at = now();
      const { count, nextDeadline } = await deps.waiting(workspaceId);
      await inWorkspace(workspaceId, (tx) => recordFetch(tx, row, at));
      return reviewIcs({
        uidBase: `${workspaceId}-${row.userId}`,
        blocks: reviewBlocks(row, at),
        count,
        nextDeadline,
        timeZone: row.timeZone,
        homeUrl: `${deps.baseUrl()}/w/${workspaceId}`,
        now: at,
      });
    },
  };
}

export type ReviewFeeds = ReturnType<typeof createReviewFeeds>;
