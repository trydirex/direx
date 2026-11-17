// SPDX-License-Identifier: AGPL-3.0-only
// Agent lessons: what one Agent should keep in mind in one Workspace, accepted by a person. A lesson
// is cancelled, never deleted, and its versions, its history and what each run carried are append-only.
import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { workspaces } from "./schema";
import { agentRuns } from "./schema-agents";

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const agentLessons = pgTable(
  "agent_lessons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    agent: text("agent").notNull(),
    state: text("state").notNull(),
    version: integer("version").notNull(),
    createdAt: tz("created_at").notNull(),
    updatedAt: tz("updated_at").notNull(),
  },
  (t) => [
    unique("agent_lessons_workspace_id_id_key").on(t.workspaceId, t.id),
    foreignKey({ name: "agent_lessons_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    index("agent_lessons_agent_idx").on(t.workspaceId, t.agent, t.state),
    check("agent_lessons_state_check", sql`${t.state} in ('live', 'cancelled')`),
    check("agent_lessons_version_check", sql`${t.version} > 0`),
  ],
);

export const agentLessonVersions = pgTable(
  "agent_lesson_versions",
  {
    workspaceId: uuid("workspace_id").notNull(),
    lessonId: uuid("lesson_id").notNull(),
    version: integer("version").notNull(),
    text: text("text").notNull(),
    // Where the words came from: a person typed them while editing something, named by source_ref.
    source: text("source").notNull(),
    sourceRef: text("source_ref"),
    definitionVersion: integer("definition_version"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "agent_lesson_versions_pk", columns: [t.workspaceId, t.lessonId, t.version] }),
    foreignKey({ name: "agent_lesson_versions_lesson_fk", columns: [t.workspaceId, t.lessonId], foreignColumns: [agentLessons.workspaceId, agentLessons.id] }),
    check("agent_lesson_versions_source_check", sql`${t.source} in ('person')`),
  ],
);

export const agentLessonEvents = pgTable(
  "agent_lesson_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    // Null for a proposal no one accepted yet.
    lessonId: uuid("lesson_id"),
    version: integer("version"),
    itemId: uuid("item_id"),
    op: text("op").notNull(),
    evidenceDigest: text("evidence_digest").notNull(),
    personId: uuid("person_id")
      .notNull()
      .references(() => user.id),
    // The permission that allowed it.
    permission: text("permission").notNull(),
    at: tz("at").notNull(),
  },
  (t) => [
    foreignKey({ name: "agent_lesson_events_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    index("agent_lesson_events_lesson_idx").on(t.workspaceId, t.lessonId),
    check("agent_lesson_events_op_check", sql`${t.op} in ('propose', 'accept', 'dismiss', 'rewrite', 'retire', 'convert')`),
  ],
);

export const agentRunLessons = pgTable(
  "agent_run_lessons",
  {
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull(),
    lessonId: uuid("lesson_id").notNull(),
    version: integer("version").notNull(),
    digest: text("digest").notNull(),
  },
  (t) => [
    primaryKey({ name: "agent_run_lessons_pk", columns: [t.workspaceId, t.runId, t.lessonId] }),
    foreignKey({ name: "agent_run_lessons_run_fk", columns: [t.workspaceId, t.runId], foreignColumns: [agentRuns.workspaceId, agentRuns.id] }),
    foreignKey({ name: "agent_run_lessons_lesson_fk", columns: [t.workspaceId, t.lessonId], foreignColumns: [agentLessons.workspaceId, agentLessons.id] }),
  ],
);
