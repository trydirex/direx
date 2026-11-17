// SPDX-License-Identifier: AGPL-3.0-only
// A Workspace's data exports (ADR 0030 rule 008): one ZIP per request, built by a job, kept under
// storage_key for 24 hours after it is ready and then removed by a sweep. The row stays as the record
// of who exported and when; the app never deletes it.
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { workspaces } from "./schema";

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const workspaceExports = pgTable(
  "workspace_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => user.id),
    requestedAt: tz("requested_at").notNull(),
    storageKey: text("storage_key").notNull(),
    readyAt: tz("ready_at"),
    bytes: bigint("bytes", { mode: "number" }),
    expiresAt: tz("expires_at"),
    failedAt: tz("failed_at"),
    removedAt: tz("removed_at"),
  },
  (t) => [
    unique("workspace_exports_workspace_id_id_key").on(t.workspaceId, t.id),
    index("workspace_exports_workspace_id_requested_at_idx").on(t.workspaceId, t.requestedAt),
    foreignKey({ name: "workspace_exports_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    check("workspace_exports_storage_key_check", sql`${t.storageKey} = ${t.workspaceId}::text || '/' || ${t.id}::text`),
    // Ready or failed, never both; a ready export has its size and lasts 24 hours.
    check("workspace_exports_ready_check", sql`(${t.readyAt} is null or ${t.failedAt} is null) and (${t.readyAt} is null) = (${t.bytes} is null) and (${t.readyAt} is null) = (${t.expiresAt} is null)`),
    check("workspace_exports_expiry_check", sql`${t.expiresAt} is null or ${t.expiresAt} = ${t.readyAt} + interval '24 hours'`),
  ],
);
