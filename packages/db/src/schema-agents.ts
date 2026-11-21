// SPDX-License-Identifier: AGPL-3.0-only
// Agent runs and their record. A run is never deleted, and what it read and did is append-only.
// None of these tables hold page text or a credential: parts and events keep digests only. The one
// text kept is a draft offered back to a person after it lost to their save (agent_proposals.body).
import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, real, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { workspaces } from "./schema";

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    agent: text("agent").notNull(),
    definitionVersion: integer("definition_version").notNull(),
    promptRevision: text("prompt_revision").notNull(),
    promptDigest: text("prompt_digest").notNull(),
    toolSetDigest: text("tool_set_digest").notNull(),
    trigger: text("trigger").notNull(),
    startedBy: uuid("started_by").references(() => user.id),
    status: text("status").notNull(),
    statusReason: text("status_reason"),
    // The claim token: every change bumps it, and a stale writer changes nothing.
    version: integer("version").notNull().default(1),
    attempt: integer("attempt").notNull().default(0),
    reclaims: integer("reclaims").notNull().default(0),
    // What broke the last attempt, so a run that ends after its lease lapsed says why, not "restarted".
    lastError: text("last_error"),
    retries: integer("retries").notNull().default(0),
    // Daily caps count admitted runs, so a run counts once, on the day it first starts.
    admittedAt: tz("admitted_at"),
    // A queued or waiting run doesn't start before this.
    resumeAt: tz("resume_at"),
    leaseExpiresAt: tz("lease_expires_at"),
    deadlineMs: integer("deadline_ms").notNull(),
    deadlineAt: tz("deadline_at"),
    stepCap: integer("step_cap").notNull(),
    steps: integer("steps").notNull().default(0),
    costCapMicros: bigint("cost_cap_micros", { mode: "bigint" }).notNull(),
    tainted: boolean("tainted").notNull().default(false),
    unevaluated: boolean("unevaluated").notNull().default(false),
    aggregateDigest: text("aggregate_digest"),
    // The digest of the Agent lessons fixed at the first claim, "" for none. Null until then.
    lessonDigest: text("lesson_digest"),
    // The address or pasted text. Pasted text is cleared when the run ends.
    input: jsonb("input").notNull(),
    createdAt: tz("created_at").notNull(),
    updatedAt: tz("updated_at").notNull(),
    endedAt: tz("ended_at"),
  },
  (t) => [
    unique("agent_runs_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("agent_runs_idempotency_key").on(t.workspaceId, t.idempotencyKey),
    foreignKey({ name: "agent_runs_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    index("agent_runs_recent").on(t.workspaceId, t.createdAt),
    index("agent_runs_admission").on(t.workspaceId, t.agent, t.status),
    check(
      "agent_runs_status_check",
      sql`${t.status} in ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'timed_out', 'step_capped', 'cost_capped', 'refused', 'expired')`,
    ),
    check("agent_runs_waiting_reason_check", sql`${t.status} <> 'waiting' or coalesce(${t.statusReason}, '') in ('daily_cap', 'budget_stop')`),
    check("agent_runs_failed_reason_check", sql`${t.status} not in ('failed', 'refused') or ${t.statusReason} is not null`),
  ],
);

export const agentRunParts = pgTable(
  "agent_run_parts",
  {
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull(),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    refId: text("ref_id").notNull(),
    version: text("version"),
    digest: text("digest").notNull(),
    trust: text("trust").notNull(),
    truncated: boolean("truncated").notNull().default(false),
    at: tz("at").notNull(),
  },
  (t) => [
    primaryKey({ name: "agent_run_parts_pkey", columns: [t.workspaceId, t.runId, t.seq] }),
    foreignKey({ name: "agent_run_parts_run_fk", columns: [t.workspaceId, t.runId], foreignColumns: [agentRuns.workspaceId, agentRuns.id] }),
    check("agent_run_parts_trust_check", sql`${t.trust} in ('trusted', 'untrusted')`),
  ],
);

export const agentRunEvents = pgTable(
  "agent_run_events",
  {
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull(),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    argumentsDigest: text("arguments_digest"),
    resultDigest: text("result_digest"),
    outcome: text("outcome").notNull(),
    // The address of a page that failed, so the run can list it. Never page text.
    ref: text("ref"),
    modelCallId: uuid("model_call_id"),
    at: tz("at").notNull(),
  },
  (t) => [
    primaryKey({ name: "agent_run_events_pkey", columns: [t.workspaceId, t.runId, t.seq] }),
    foreignKey({ name: "agent_run_events_run_fk", columns: [t.workspaceId, t.runId], foreignColumns: [agentRuns.workspaceId, agentRuns.id] }),
    check("agent_run_events_kind_check", sql`${t.kind} in ('model_call', 'tool_call', 'proposal', 'rejection')`),
  ],
);

// The row is written first, then handed over, then item_id is filled in, so a crash in between
// is finished by the retry.
export const agentProposals = pgTable(
  "agent_proposals",
  {
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull(),
    outputKey: text("output_key").notNull(),
    kind: text("kind").notNull(),
    itemId: uuid("item_id"),
    rejectionCode: text("rejection_code"),
    incomplete: boolean("incomplete").notNull().default(false),
    routeHash: text("route_hash"),
    at: tz("at").notNull(),
    // A draft that lost to a person's save is kept here and offered to them, never applied on its own.
    body: jsonb("body"),
    targetKind: text("target_kind"),
    targetId: uuid("target_id"),
    targetStepKey: text("target_step_key"),
    offer: text("offer"),
    offerBy: uuid("offer_by").references(() => user.id),
    offerAt: tz("offer_at"),
  },
  (t) => [
    primaryKey({ name: "agent_proposals_pkey", columns: [t.workspaceId, t.runId, t.outputKey] }),
    foreignKey({ name: "agent_proposals_run_fk", columns: [t.workspaceId, t.runId], foreignColumns: [agentRuns.workspaceId, agentRuns.id] }),
    // An Item's "Written from" line finds the Run whose proposal became it.
    index("agent_proposals_item_idx").on(t.workspaceId, t.itemId),
    check("agent_proposals_offer_check", sql`${t.offer} is null or (${t.offer} in ('open', 'used', 'dismissed', 'replaced') and ${t.body} is not null and ${t.targetKind} in ('strategy', 'plan', 'step'))`),
    // The Strategy has no id, one per Workspace, so the key reads a missing id or step as one value.
    uniqueIndex("agent_proposals_one_open_offer")
      .on(t.workspaceId, t.targetKind, sql`coalesce(${t.targetId}, '00000000-0000-0000-0000-000000000000'::uuid)`, sql`coalesce(${t.targetStepKey}, '')`)
      .where(sql`${t.offer} = 'open'`),
  ],
);

export const agentCancellations = pgTable(
  "agent_cancellations",
  {
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull(),
    source: text("source").notNull(),
    who: uuid("who").references(() => user.id),
    reason: text("reason"),
    at: tz("at").notNull(),
  },
  (t) => [
    primaryKey({ name: "agent_cancellations_pkey", columns: [t.workspaceId, t.runId] }),
    foreignKey({ name: "agent_cancellations_run_fk", columns: [t.workspaceId, t.runId], foreignColumns: [agentRuns.workspaceId, agentRuns.id] }),
    check("agent_cancellations_source_check", sql`${t.source} in ('person', 'admin', 'queued_message', 'shutdown', 'emergency_pause')`),
    check("agent_cancellations_who_check", sql`${t.source} not in ('person', 'admin') or ${t.who} is not null`),
  ],
);

export const agentSettings = pgTable(
  "agent_settings",
  {
    workspaceId: uuid("workspace_id").notNull(),
    agent: text("agent").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    maxConcurrentRuns: integer("max_concurrent_runs"),
    maxDailyRuns: integer("max_daily_runs"),
    revision: integer("revision").notNull().default(1),
    updatedAt: tz("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "agent_settings_pkey", columns: [t.workspaceId, t.agent] }),
    foreignKey({ name: "agent_settings_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
  ],
);

export const agentSettingRevisions = pgTable(
  "agent_setting_revisions",
  {
    workspaceId: uuid("workspace_id").notNull(),
    agent: text("agent").notNull(),
    revision: integer("revision").notNull(),
    settings: jsonb("settings").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => user.id),
    at: tz("at").notNull(),
  },
  (t) => [
    primaryKey({ name: "agent_setting_revisions_pkey", columns: [t.workspaceId, t.agent, t.revision] }),
    foreignKey({ name: "agent_setting_revisions_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
  ],
);

// A new agent version whose rejection or citation-failure rate rose past ADR 0008's line against the
// version before it (rule 026). One row per version and measure, so its Owners are told once. Counts
// and rates only, never a draft's words. Written once, never changed.
export const agentDriftIncidents = pgTable(
  "agent_drift_incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    agent: text("agent").notNull(),
    definitionVersion: integer("definition_version").notNull(),
    routeHash: text("route_hash").notNull(),
    measure: text("measure").notNull(),
    previousDefinitionVersion: integer("previous_definition_version").notNull(),
    // Proposals written before routes were hashed have none.
    previousRouteHash: text("previous_route_hash"),
    rate: real("rate").notNull(),
    previousRate: real("previous_rate").notNull(),
    runs: integer("runs").notNull(),
    previousRuns: integer("previous_runs").notNull(),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    unique("agent_drift_incidents_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("agent_drift_incidents_version_measure_key").on(t.workspaceId, t.agent, t.definitionVersion, t.routeHash, t.measure),
    foreignKey({ name: "agent_drift_incidents_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    check("agent_drift_incidents_measure_check", sql`${t.measure} in ('rejections', 'citations')`),
  ],
);
