// SPDX-License-Identifier: AGPL-3.0-only
// Setup samples and Voice (ADR 0022). A sample is a draft Direx writes during setup to show how it
// writes; it is never an Item or an Action and nothing sends it. Voice is how drafts should sound:
// example passages and word swaps, kept beside the Facts but never a source for a claim. Both keep
// their words in versions that never change; an erased Voice version keeps only its digest.
import { sql } from "drizzle-orm";
import { check, foreignKey, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { workspaces } from "./schema";
import { agentRuns } from "./schema-agents";

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const brandSamples = pgTable(
  "brand_samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    kind: text("kind").notNull(),
    currentRevision: integer("current_revision").notNull(),
    createdAt: tz("created_at").notNull(),
    updatedAt: tz("updated_at").notNull(),
  },
  (t) => [
    unique("brand_samples_workspace_id_id_key").on(t.workspaceId, t.id),
    // One sample of each kind per Workspace; a rewrite is a new revision of it.
    unique("brand_samples_one_per_kind").on(t.workspaceId, t.kind),
    foreignKey({ name: "brand_samples_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    check("brand_samples_kind_check", sql`${t.kind} in ('linkedin_post', 'cold_email', 'newsletter_opening')`),
    check("brand_samples_revision_check", sql`${t.currentRevision} > 0`),
  ],
);

export const brandSampleRevisions = pgTable(
  "brand_sample_revisions",
  {
    workspaceId: uuid("workspace_id").notNull(),
    sampleId: uuid("sample_id").notNull(),
    revision: integer("revision").notNull(),
    // An email's subject; null for a post or a newsletter opening.
    subject: text("subject"),
    text: text("text").notNull(),
    digest: text("digest").notNull(),
    // The run that wrote it, and for a rewrite what the person asked.
    runId: uuid("run_id").notNull(),
    asked: text("asked"),
    at: tz("at").notNull(),
  },
  (t) => [
    primaryKey({ name: "brand_sample_revisions_pkey", columns: [t.workspaceId, t.sampleId, t.revision] }),
    foreignKey({ name: "brand_sample_revisions_sample_fk", columns: [t.workspaceId, t.sampleId], foreignColumns: [brandSamples.workspaceId, brandSamples.id] }),
    foreignKey({ name: "brand_sample_revisions_run_fk", columns: [t.workspaceId, t.runId], foreignColumns: [agentRuns.workspaceId, agentRuns.id] }),
    check("brand_sample_revisions_text_check", sql`char_length(${t.text}) between 1 and 4000`),
  ],
);

export const voiceEntries = pgTable(
  "voice_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    kind: text("kind").notNull(),
    currentVersion: integer("current_version").notNull(),
    retiredAt: tz("retired_at"),
    retiredBy: uuid("retired_by").references(() => user.id),
    createdAt: tz("created_at").notNull(),
    updatedAt: tz("updated_at").notNull(),
  },
  (t) => [
    unique("voice_entries_workspace_id_id_key").on(t.workspaceId, t.id),
    foreignKey({ name: "voice_entries_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    check("voice_entries_kind_check", sql`${t.kind} in ('example', 'swap')`),
    check("voice_entries_version_check", sql`${t.currentVersion} > 0`),
  ],
);

export const voiceVersions = pgTable(
  "voice_versions",
  {
    workspaceId: uuid("workspace_id").notNull(),
    entryId: uuid("entry_id").notNull(),
    version: integer("version").notNull(),
    // An example's passage, or a swap's word to avoid. Null only once erased.
    text: text("text"),
    // A swap's word to use instead; null for an example.
    prefer: text("prefer"),
    // Where the words came from: a person's paste, or a sample they marked as sounding like them.
    // The sample is named by id, revision and digest without a foreign key, so samples can go
    // without taking Voice with them.
    source: text("source").notNull(),
    sampleId: uuid("sample_id"),
    sampleRevision: integer("sample_revision"),
    sampleDigest: text("sample_digest"),
    digest: text("digest").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => user.id),
    at: tz("at").notNull(),
    erasedAt: tz("erased_at"),
  },
  (t) => [
    primaryKey({ name: "voice_versions_pkey", columns: [t.workspaceId, t.entryId, t.version] }),
    foreignKey({ name: "voice_versions_entry_fk", columns: [t.workspaceId, t.entryId], foreignColumns: [voiceEntries.workspaceId, voiceEntries.id] }),
    check("voice_versions_source_check", sql`${t.source} in ('person', 'sample')`),
    check("voice_versions_sample_check", sql`(${t.source} = 'sample') = (num_nonnulls(${t.sampleId}, ${t.sampleRevision}, ${t.sampleDigest}) = 3)`),
    check("voice_versions_erased_check", sql`(${t.erasedAt} is null) = (${t.text} is not null)`),
    check("voice_versions_erased_prefer_check", sql`${t.erasedAt} is null or ${t.prefer} is null`),
    check("voice_versions_length_check", sql`char_length(${t.text}) <= 600 and char_length(${t.prefer}) <= 40`),
  ],
);
