// SPDX-License-Identifier: AGPL-3.0-only
// Every review feed SQL statement, inside one Workspace.
import { and, eq, sql } from "drizzle-orm";
import { withWorkspace, type WorkspaceTx } from "@direx/db";
import { reviewFeeds } from "@direx/db/schema";
import type { FeedSettings } from "../domain/ics";

export type FeedTx = WorkspaceTx;
export type FeedRow = typeof reviewFeeds.$inferSelect;

export const inWorkspace = <T>(workspaceId: string, fn: (tx: FeedTx) => Promise<T>) => withWorkspace(workspaceId, fn);

export async function feedOf(tx: FeedTx, userId: string): Promise<FeedRow | undefined> {
  const [row] = await tx.select().from(reviewFeeds).where(eq(reviewFeeds.userId, userId));
  return row;
}

export async function feedByHash(tx: FeedTx, tokenHash: string): Promise<FeedRow | undefined> {
  const [row] = await tx.select().from(reviewFeeds).where(eq(reviewFeeds.tokenHash, tokenHash));
  return row;
}

/** Makes the member's feed, or gives it new settings and a new token; a rotation keeps when it was made. */
export async function upsertFeed(tx: FeedTx, f: { workspaceId: string; userId: string; tokenHash: string; settings: FeedSettings; now: Date }) {
  const s = { weekdays: f.settings.weekdays, startMinute: f.settings.startMinute, lengthMinutes: f.settings.lengthMinutes, timeZone: f.settings.timeZone };
  await tx
    .insert(reviewFeeds)
    .values({ workspaceId: f.workspaceId, userId: f.userId, tokenHash: f.tokenHash, ...s, createdAt: f.now })
    .onConflictDoUpdate({ target: [reviewFeeds.workspaceId, reviewFeeds.userId], set: { tokenHash: f.tokenHash, ...s } });
}

export async function updateSettings(tx: FeedTx, userId: string, s: FeedSettings): Promise<boolean> {
  const rows = await tx
    .update(reviewFeeds)
    .set({ weekdays: s.weekdays, startMinute: s.startMinute, lengthMinutes: s.lengthMinutes, timeZone: s.timeZone })
    .where(eq(reviewFeeds.userId, userId))
    .returning({ userId: reviewFeeds.userId });
  return rows.length > 0;
}

export async function deleteFeed(tx: FeedTx, userId: string): Promise<boolean> {
  const rows = await tx.delete(reviewFeeds).where(eq(reviewFeeds.userId, userId)).returning({ userId: reviewFeeds.userId });
  return rows.length > 0;
}

export async function recordFetch(tx: FeedTx, row: FeedRow, now: Date) {
  await tx
    .update(reviewFeeds)
    .set({ lastFetchedAt: now, fetchCount: sql`${reviewFeeds.fetchCount} + 1` })
    .where(and(eq(reviewFeeds.userId, row.userId), eq(reviewFeeds.tokenHash, row.tokenHash)));
}
