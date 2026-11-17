// SPDX-License-Identifier: AGPL-3.0-only
// Clip runs: one uploaded video transcribed, its moments picked by an agent and checked in code, and
// each kept moment cut into a clip stored in media. Rows are never deleted.
import { sql } from "drizzle-orm";
import { check, foreignKey, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { media } from "./schema-media";
import { workspaces } from "./schema";

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const clipRuns = pgTable(
  "clip_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    sourceMediaId: uuid("source_media_id").notNull(),
    // The plan whose measures a moment may name instead of a Fact. Not a foreign key: plans are archived, not deleted.
    planId: uuid("plan_id"),
    state: text("state").notNull(),
    // Words with times, kept so picking again needs no new transcription.
    transcript: jsonb("transcript"),
    durationMs: integer("duration_ms"),
    agentRunId: uuid("agent_run_id"),
    // The moments kept and dropped, each dropped one with why.
    moments: jsonb("moments"),
    failure: text("failure"),
    startedBy: uuid("started_by").notNull().references(() => user.id),
    createdAt: tz("created_at").notNull(),
    updatedAt: tz("updated_at").notNull(),
  },
  (t) => [
    unique("clip_runs_workspace_id_id_key").on(t.workspaceId, t.id),
    // One run at a time per source, so a second press can't cut the same video twice.
    uniqueIndex("clip_runs_one_live_per_source").on(t.workspaceId, t.sourceMediaId).where(sql`${t.state} not in ('done', 'failed')`),
    foreignKey({ name: "clip_runs_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "clip_runs_source_fk", columns: [t.workspaceId, t.sourceMediaId], foreignColumns: [media.workspaceId, media.id] }),
    check("clip_runs_state_check", sql`${t.state} in ('queued', 'transcribing', 'picking', 'cutting', 'done', 'failed')`),
    check("clip_runs_failure_check", sql`(${t.state} = 'failed') = (${t.failure} is not null)`),
  ],
);

export const clips = pgTable(
  "clips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull(),
    // The moment's place in the run's kept list, so a retried cut skips what is already done.
    position: integer("position").notNull(),
    mediaId: uuid("media_id").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    title: text("title").notNull(),
    caption: text("caption").notNull(),
    // "fact_id@version", each checked when the moment was kept.
    citations: jsonb("citations").notNull(),
    measureKey: text("measure_key"),
    why: text("why").notNull(),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    unique("clips_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("clips_run_position_key").on(t.workspaceId, t.runId, t.position),
    foreignKey({ name: "clips_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "clips_run_fk", columns: [t.workspaceId, t.runId], foreignColumns: [clipRuns.workspaceId, clipRuns.id] }),
    foreignKey({ name: "clips_media_fk", columns: [t.workspaceId, t.mediaId], foreignColumns: [media.workspaceId, media.id] }),
    check("clips_times_check", sql`${t.startMs} >= 0 and ${t.endMs} > ${t.startMs}`),
  ],
);
