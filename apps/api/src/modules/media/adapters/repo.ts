// SPDX-License-Identifier: AGPL-3.0-only
// Media rows. Every call runs inside the Workspace, so RLS hides other Workspaces' files; only the
// sweep's list crosses Workspaces, through its system function.
import { withSystem, withWorkspace } from "@direx/db";
import { media } from "@direx/db/schema-media";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

export { MEDIA_MAX_BYTES } from "@direx/db/schema-media";

export type MediaRow = typeof media.$inferSelect;
export type NewMedia = typeof media.$inferInsert & { id: string };

export function insertMedia(row: NewMedia): Promise<MediaRow> {
  return withWorkspace(row.workspaceId, async (tx) => {
    const [made] = await tx.insert(media).values(row).returning();
    return made!;
  });
}

/** A file that is still there; a deleted one reads as missing. */
export function liveMedia(workspaceId: string, id: string): Promise<MediaRow | undefined> {
  return withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx.select().from(media).where(and(eq(media.id, id), isNull(media.deletedAt)));
    return row;
  });
}

/** The newest uploaded videos still there, for Ask to name one by. */
export function liveSources(workspaceId: string, limit: number): Promise<Pick<MediaRow, "id" | "fileName" | "createdAt">[]> {
  return withWorkspace(workspaceId, (tx) =>
    tx.select({ id: media.id, fileName: media.fileName, createdAt: media.createdAt }).from(media).where(and(eq(media.kind, "source"), isNull(media.deletedAt))).orderBy(desc(media.createdAt)).limit(limit),
  );
}

/** Marks a file deleted; the sweep removes its bytes. False when there was nothing live to delete. */
export function markDeleted(workspaceId: string, id: string, at: Date): Promise<boolean> {
  return withWorkspace(workspaceId, async (tx) => {
    const rows = await tx.update(media).set({ deletedAt: at }).where(and(eq(media.id, id), isNull(media.deletedAt))).returning({ id: media.id });
    return rows.length > 0;
  });
}

export type DueFile = { workspaceId: string; id: string; storageKey: string };

/** Marks sources older than sourceDays deleted, then lists every deleted file whose bytes are still stored. */
export async function sweepDue(at: Date, sourceDays: number): Promise<DueFile[]> {
  const { rows } = await withSystem((tx) => tx.execute(sql`select workspace_id, id, storage_key from system.media_sweep_due(${at.toISOString()}::timestamptz, ${sourceDays}::integer)`));
  return rows.map((r) => ({ workspaceId: r.workspace_id as string, id: r.id as string, storageKey: r.storage_key as string }));
}

/** Records that a deleted file's bytes are gone. */
export function markBytesRemoved(workspaceId: string, id: string, at: Date): Promise<void> {
  return withWorkspace(workspaceId, async (tx) => {
    await tx.update(media).set({ bytesRemovedAt: at }).where(and(eq(media.id, id), isNotNull(media.deletedAt), isNull(media.bytesRemovedAt)));
  });
}
