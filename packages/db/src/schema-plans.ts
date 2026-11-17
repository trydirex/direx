// SPDX-License-Identifier: AGPL-3.0-only
// Strategy and marketing plans. A version never changes, so an approval always means the words
// someone read; only the draft on the head row is edited. Progress and readings are append-only.
import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { workspaces } from "./schema";

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const strategies = pgTable(
  "strategies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    currentVersion: integer("current_version"),
    draft: jsonb("draft"),
    draftRevision: integer("draft_revision").notNull().default(0),
    // The run that wrote the draft as it stands, until a person saves over it.
    draftRunId: uuid("draft_run_id"),
    createdAt: tz("created_at").notNull(),
    updatedAt: tz("updated_at").notNull(),
  },
  (t) => [
    unique("strategies_one_per_workspace").on(t.workspaceId),
    unique("strategies_workspace_id_id_key").on(t.workspaceId, t.id),
    foreignKey({ name: "strategies_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
  ],
);

export const strategyVersions = pgTable(
  "strategy_versions",
  {
    workspaceId: uuid("workspace_id").notNull(),
    strategyId: uuid("strategy_id").notNull(),
    version: integer("version").notNull(),
    body: jsonb("body").notNull(),
    digest: text("digest").notNull(),
    baseVersion: integer("base_version"),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => user.id),
    at: tz("at").notNull(),
  },
  (t) => [
    primaryKey({ name: "strategy_versions_pkey", columns: [t.workspaceId, t.strategyId, t.version] }),
    foreignKey({ name: "strategy_versions_strategy_fk", columns: [t.workspaceId, t.strategyId], foreignColumns: [strategies.workspaceId, strategies.id] }),
  ],
);

export const marketingPlans = pgTable(
  "marketing_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    title: text("title").notNull(),
    request: text("request"),
    currentVersion: integer("current_version"),
    draft: jsonb("draft"),
    draftRevision: integer("draft_revision").notNull().default(0),
    draftRunId: uuid("draft_run_id"),
    // Who started the plan, and so owns its Campaign (ADR 0023). Null only on plans made before it was kept.
    createdBy: uuid("created_by").references(() => user.id),
    archivedAt: tz("archived_at"),
    createdAt: tz("created_at").notNull(),
    updatedAt: tz("updated_at").notNull(),
  },
  (t) => [
    unique("marketing_plans_workspace_id_id_key").on(t.workspaceId, t.id),
    foreignKey({ name: "marketing_plans_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
  ],
);

export const marketingPlanVersions = pgTable(
  "marketing_plan_versions",
  {
    workspaceId: uuid("workspace_id").notNull(),
    planId: uuid("plan_id").notNull(),
    version: integer("version").notNull(),
    body: jsonb("body").notNull(),
    digest: text("digest").notNull(),
    baseVersion: integer("base_version"),
    strategyId: uuid("strategy_id").notNull(),
    strategyVersion: integer("strategy_version").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => user.id),
    at: tz("at").notNull(),
  },
  (t) => [
    primaryKey({ name: "marketing_plan_versions_pkey", columns: [t.workspaceId, t.planId, t.version] }),
    foreignKey({ name: "marketing_plan_versions_plan_fk", columns: [t.workspaceId, t.planId], foreignColumns: [marketingPlans.workspaceId, marketingPlans.id] }),
    foreignKey({
      name: "marketing_plan_versions_strategy_fk",
      columns: [t.workspaceId, t.strategyId, t.strategyVersion],
      foreignColumns: [strategyVersions.workspaceId, strategyVersions.strategyId, strategyVersions.version],
    }),
  ],
);

export const planStepProgress = pgTable(
  "plan_step_progress",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    planId: uuid("plan_id").notNull(),
    stepKey: text("step_key").notNull(),
    status: text("status").notNull(),
    actorUserId: uuid("actor_user_id").references(() => user.id),
    actorSystem: text("actor_system"),
    at: tz("at").notNull(),
  },
  (t) => [
    index("plan_step_progress_plan_idx").on(t.workspaceId, t.planId, t.at),
    foreignKey({ name: "plan_step_progress_plan_fk", columns: [t.workspaceId, t.planId], foreignColumns: [marketingPlans.workspaceId, marketingPlans.id] }),
    check("plan_step_progress_status_check", sql`${t.status} in ('done', 'skipped', 'open')`),
    check("plan_step_progress_one_actor_check", sql`num_nonnulls(${t.actorUserId}, ${t.actorSystem}) = 1`),
  ],
);

export const planMeasureReadings = pgTable(
  "plan_measure_readings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    planId: uuid("plan_id").notNull(),
    measureKey: text("measure_key").notNull(),
    value: text("value").notNull(),
    observedOn: date("observed_on").notNull(),
    source: text("source").notNull(),
    note: text("note"),
    actorUserId: uuid("actor_user_id").references(() => user.id),
    actorSystem: text("actor_system"),
    at: tz("at").notNull(),
  },
  (t) => [
    index("plan_measure_readings_plan_idx").on(t.workspaceId, t.planId, t.at),
    foreignKey({ name: "plan_measure_readings_plan_fk", columns: [t.workspaceId, t.planId], foreignColumns: [marketingPlans.workspaceId, marketingPlans.id] }),
    check("plan_measure_readings_source_check", sql`${t.source} in ('person', 'system')`),
    check("plan_measure_readings_one_actor_check", sql`num_nonnulls(${t.actorUserId}, ${t.actorSystem}) = 1`),
    // The label "entered by you" comes from source, so it can't disagree with who wrote the row.
    check("plan_measure_readings_source_matches_actor_check", sql`(${t.source} = 'person') = (${t.actorUserId} is not null)`),
  ],
);

// A sentence a person saved to start a Campaign from later (GLOSSARY "Idea"). Not an Item: it has no state
// and nothing waits on it. Open while `plan_id` is null and it isn't dismissed. Delete draft clears
// `plan_id` through the foreign key, so the Idea is open again (ADR 0023 rule 005, revised 2026-11-14).
export const ideas = pgTable(
  "ideas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    text: text("text").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: tz("created_at").notNull(),
    planId: uuid("plan_id"),
    startedAt: tz("started_at"),
    dismissedAt: tz("dismissed_at"),
  },
  (t) => [
    foreignKey({ name: "ideas_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    // The migration writes this as ON DELETE SET NULL ("plan_id"): only the link is cleared, never workspace_id.
    foreignKey({ name: "ideas_plan_fk", columns: [t.workspaceId, t.planId], foreignColumns: [marketingPlans.workspaceId, marketingPlans.id] }).onDelete("set null"),
    check("ideas_text_check", sql`char_length(${t.text}) between 1 and 500 and ${t.text} = btrim(${t.text})`),
    check("ideas_started_check", sql`${t.planId} is null or ${t.startedAt} is not null`),
    index("ideas_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);
