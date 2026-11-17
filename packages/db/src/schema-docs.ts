// SPDX-License-Identifier: AGPL-3.0-only
// A docs tool's database imported to the Calendar (Notion first): the database, how its columns map to
// a post, and each row with the post it became. The connection is found when a read runs, never kept
// here, so a replaced key strands nothing. A row is imported once per source.
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { credentials, items, workspaces } from "./schema";

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const docSources = pgTable(
  "doc_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    // The docs tool's own id for it: for Notion, the data source id.
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    // Which column is the date, the channel and the text, and which account each channel value posts as.
    mapping: jsonb("mapping").notNull(),
    setBy: uuid("set_by")
      .notNull()
      .references(() => user.id),
    createdAt: tz("created_at").notNull(),
    updatedAt: tz("updated_at").notNull(),
    // The last time a read finished; the next Check again asks for rows edited since then.
    checkedAt: tz("checked_at"),
    // ADR 0025: the credential the source reads and writes with, and the write-back mapping by id
    // (status property, an option per Direx state, URL property). A change to either bumps the version.
    credentialId: uuid("credential_id"),
    writeBack: jsonb("write_back"),
    mappingVersion: integer("mapping_version").notNull().default(0),
  },
  (t) => [
    unique("doc_sources_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("doc_sources_one_per_external").on(t.workspaceId, t.externalId),
    foreignKey({ name: "doc_sources_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "doc_sources_credential_fk", columns: [t.workspaceId, t.credentialId], foreignColumns: [credentials.workspaceId, credentials.id] }),
    check("doc_sources_external_check", sql`${t.externalId} <> '' and char_length(${t.externalId}) <= 200`),
  ],
);

export const docRows = pgTable(
  "doc_rows",
  {
    workspaceId: uuid("workspace_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    externalId: text("external_id").notNull(),
    // The post the row became, and its revision then: a post still at that revision is nobody's edit.
    itemId: uuid("item_id").notNull(),
    importedRevision: integer("imported_revision").notNull(),
    // The row's last edit in the docs tool, as last read.
    editedAt: tz("edited_at"),
    // Why the row and its post went apart: changed in the docs tool after the post was edited or decided.
    flag: text("flag"),
    // ADR 0025: what Direx last wrote back, the edit time that write produced (seen, not a person's
    // change), and the generation of the newest write-back, which a write must still be to go out.
    writtenState: text("written_state"),
    writtenOptionId: text("written_option_id"),
    writtenEditedAt: tz("written_edited_at"),
    generation: integer("generation").notNull().default(0),
    // The row's newest write-back Action, so stopping a source's grant cancels by source, not by credential.
    writeActionId: uuid("write_action_id"),
    createdAt: tz("created_at").notNull(),
    updatedAt: tz("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "doc_rows_pkey", columns: [t.workspaceId, t.sourceId, t.externalId] }),
    foreignKey({ name: "doc_rows_source_fk", columns: [t.workspaceId, t.sourceId], foreignColumns: [docSources.workspaceId, docSources.id] }),
    foreignKey({ name: "doc_rows_item_fk", columns: [t.workspaceId, t.itemId], foreignColumns: [items.workspaceId, items.id] }),
    check("doc_rows_flag_check", sql`${t.flag} is null or ${t.flag} in ('changed_in_source')`),
  ],
);

// ADR 0025: a person's recorded yes or no to writing an imported source's status back. Answers are
// appended; the newest counts. A yes binds the credential and the write-back mapping it was given for,
// and stops when either changes, the wording changes or the granter loses `rule.grant`.
export const docWriteGrants = pgTable(
  "doc_write_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    workspaceId: uuid("workspace_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    credentialId: uuid("credential_id").notNull(),
    mappingHash: text("mapping_hash").notNull(),
    answer: text("answer").notNull(),
    wordingVersion: text("wording_version").notNull(),
    answeredBy: uuid("answered_by")
      .notNull()
      .references(() => user.id),
    answeredAt: tz("answered_at").notNull(),
    stoppedBy: uuid("stopped_by").references(() => user.id),
    stoppedAt: tz("stopped_at"),
    stopReason: text("stop_reason"),
  },
  (t) => [
    unique("doc_write_grants_workspace_id_id_key").on(t.workspaceId, t.id),
    index("doc_write_grants_current_idx").on(t.workspaceId, t.sourceId, t.seq),
    foreignKey({ name: "doc_write_grants_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "doc_write_grants_source_fk", columns: [t.workspaceId, t.sourceId], foreignColumns: [docSources.workspaceId, docSources.id] }),
    foreignKey({ name: "doc_write_grants_credential_fk", columns: [t.workspaceId, t.credentialId], foreignColumns: [credentials.workspaceId, credentials.id] }),
    check("doc_write_grants_answer_check", sql`${t.answer} in ('yes', 'no')`),
    check("doc_write_grants_hash_check", sql`${t.mappingHash} ~ '^[0-9a-f]{64}$'`),
    check("doc_write_grants_stop_check", sql`(${t.stoppedAt} is null and ${t.stoppedBy} is null and ${t.stopReason} is null) or (${t.answer} = 'yes' and ${t.stoppedAt} is not null and length(${t.stopReason}) between 1 and 500)`),
  ],
);
