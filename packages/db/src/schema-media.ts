// SPDX-License-Identifier: AGPL-3.0-only
// Files a person uploaded and the clips cut from them. The bytes live on disk or in object storage
// under storage_key; a row is never deleted, only marked, so a sweep can remove the bytes after.
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { workspaces } from "./schema";

const tz = (name: string) => timestamp(name, { withTimezone: true });

/** The largest file Direx keeps: 2 GiB [DEFAULT]. */
export const MEDIA_MAX_BYTES = 2 * 1024 ** 3;

export const media = pgTable(
  "media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    kind: text("kind").notNull(),
    contentType: text("content_type").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    // Shown to people only; never part of a path.
    fileName: text("file_name").notNull(),
    uploadedBy: uuid("uploaded_by").notNull().references(() => user.id),
    createdAt: tz("created_at").notNull().defaultNow(),
    deletedAt: tz("deleted_at"),
    bytesRemovedAt: tz("bytes_removed_at"),
  },
  (t) => [
    unique("media_workspace_id_id_key").on(t.workspaceId, t.id),
    index("media_sweep_idx").on(t.workspaceId, t.kind, t.createdAt),
    foreignKey({ name: "media_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    check("media_kind_check", sql`${t.kind} in ('source', 'clip')`),
    check("media_content_type_check", sql`${t.contentType} in ('video/mp4', 'video/quicktime', 'video/webm', 'image/png', 'image/jpeg', 'image/gif', 'image/webp')`),
    check("media_bytes_check", sql`${t.bytes} > 0 and ${t.bytes} <= 2147483648`),
    check("media_sha256_check", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("media_file_name_check", sql`char_length(${t.fileName}) between 1 and 255`),
    check("media_removed_after_deleted_check", sql`${t.bytesRemovedAt} is null or ${t.deletedAt} is not null`),
  ],
);
