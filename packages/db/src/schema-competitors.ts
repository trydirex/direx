// SPDX-License-Identifier: AGPL-3.0-only
// The competitors a Workspace watches: a name and the pages a person gave for each one. At most 5 per
// Workspace, which the API enforces under a lock; the database keeps names unique and a URL present.
import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { items, workspaces } from "./schema";

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const competitors = pgTable(
  "competitors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    pricingUrl: text("pricing_url"),
    changelogUrl: text("changelog_url"),
    landingUrl: text("landing_url"),
    // Our own page comparing us with this competitor, if there is one; counter-moves link it.
    comparisonUrl: text("comparison_url"),
    createdBy: uuid("created_by").notNull().references(() => user.id),
    createdAt: tz("created_at").notNull(),
    updatedAt: tz("updated_at").notNull(),
  },
  (t) => [
    unique("competitors_workspace_id_id_key").on(t.workspaceId, t.id),
    uniqueIndex("competitors_name_key").on(t.workspaceId, sql`lower(${t.name})`),
    foreignKey({ name: "competitors_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    check("competitors_one_url_check", sql`coalesce(${t.pricingUrl}, ${t.changelogUrl}, ${t.landingUrl}) is not null`),
    check("competitors_name_check", sql`char_length(${t.name}) between 1 and 100`),
  ],
);

// One weekly read of one competitor page: only the compared parts, never the page. A failed read keeps
// its reason and no parts. Removing a competitor removes its snapshots and Changes.
export const competitorSnapshots = pgTable(
  "competitor_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    competitorId: uuid("competitor_id").notNull(),
    source: text("source").notNull(),
    url: text("url").notNull(),
    finalUrl: text("final_url"),
    // The Monday, in UTC, of the week read: one read per page per week.
    week: date("week", { mode: "string" }).notNull(),
    readAt: tz("read_at").notNull(),
    failure: text("failure"),
    truncated: boolean("truncated").notNull().default(false),
    // { lines } for pricing and changelog; { title, description, headline, subhead } for landing.
    parts: jsonb("parts"),
  },
  (t) => [
    unique("competitor_snapshots_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("competitor_snapshots_week_key").on(t.competitorId, t.source, t.week),
    index("competitor_snapshots_last_idx").on(t.workspaceId, t.competitorId, t.source, t.readAt),
    foreignKey({ name: "competitor_snapshots_competitor_fk", columns: [t.workspaceId, t.competitorId], foreignColumns: [competitors.workspaceId, competitors.id] }).onDelete("cascade"),
    check("competitor_snapshots_source_check", sql`${t.source} in ('pricing', 'changelog', 'landing')`),
    check("competitor_snapshots_outcome_check", sql`(${t.failure} is null) = (${t.parts} is not null)`),
  ],
);

// What changed between two good snapshots of one page. `detail` is { added, removed? }, { part, before,
// after } or { rewritten: { added, removed } }. change-classifier adds its label in its own migration.
export const competitorChanges = pgTable(
  "competitor_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    competitorId: uuid("competitor_id").notNull(),
    source: text("source").notNull(),
    beforeSnapshotId: uuid("before_snapshot_id").notNull(),
    afterSnapshotId: uuid("after_snapshot_id").notNull(),
    detail: jsonb("detail").notNull(),
    createdAt: tz("created_at").notNull(),
    // The classifier's label, all null until a run labels the Change. `sameAs` is an earlier sighting
    // of the same event, from the same competitor, so removing a competitor cascades through it.
    label: text("label"),
    kind: text("kind"),
    sameAsChangeId: uuid("same_as_change_id"),
    reason: text("reason"),
    labelledAt: tz("labelled_at"),
    runId: uuid("run_id"),
    // The counter-move this answer belongs to: its own Item, or its event's. Deleting the Item nulls
    // only this column (the migration says SET NULL ("item_id"); drizzle can't name the column).
    itemId: uuid("item_id"),
  },
  (t) => [
    index("competitor_changes_recent_idx").on(t.workspaceId, t.competitorId, t.createdAt),
    unique("competitor_changes_competitor_id_key").on(t.workspaceId, t.competitorId, t.id),
    foreignKey({ name: "competitor_changes_same_as_fk", columns: [t.workspaceId, t.competitorId, t.sameAsChangeId], foreignColumns: [t.workspaceId, t.competitorId, t.id] }).onDelete("cascade"),
    check("competitor_changes_label_check", sql`${t.label} is null or ${t.label} in ('answer', 'noise')`),
    check(
      "competitor_changes_kind_check",
      sql`(${t.kind} is null) = (${t.label} is distinct from 'answer') and (${t.kind} is null or ${t.kind} in ('fact_update', 'comparison_page', 'post', 'ranking_brief'))`,
    ),
    check("competitor_changes_same_as_check", sql`${t.sameAsChangeId} is null or (${t.label} = 'answer' and ${t.sameAsChangeId} <> ${t.id})`),
    check("competitor_changes_labelled_check", sql`(${t.label} is null) = (${t.labelledAt} is null) and (${t.label} is null) = (${t.reason} is null)`),
    check("competitor_changes_reason_check", sql`${t.reason} is null or char_length(${t.reason}) between 1 and 200`),
    foreignKey({ name: "competitor_changes_competitor_fk", columns: [t.workspaceId, t.competitorId], foreignColumns: [competitors.workspaceId, competitors.id] }).onDelete("cascade"),
    foreignKey({ name: "competitor_changes_before_fk", columns: [t.workspaceId, t.beforeSnapshotId], foreignColumns: [competitorSnapshots.workspaceId, competitorSnapshots.id] }).onDelete("cascade"),
    foreignKey({ name: "competitor_changes_after_fk", columns: [t.workspaceId, t.afterSnapshotId], foreignColumns: [competitorSnapshots.workspaceId, competitorSnapshots.id] }).onDelete("cascade"),
    foreignKey({ name: "competitor_changes_item_fk", columns: [t.workspaceId, t.itemId], foreignColumns: [items.workspaceId, items.id] }).onDelete("set null"),
    check("competitor_changes_item_check", sql`${t.itemId} is null or ${t.label} is not distinct from 'answer'`),
    check("competitor_changes_source_check", sql`${t.source} in ('pricing', 'changelog', 'landing')`),
  ],
);
