// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

// RLS, FORCE and policies for these tables live in a hand-written migration,
// because drizzle-kit cannot emit FORCE ROW LEVEL SECURITY.

export const notes = pgTable(
  "notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [unique("notes_workspace_id_id_key").on(t.workspaceId, t.id)],
);

export const noteComments = pgTable(
  "note_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    noteId: uuid("note_id").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    // Composite FK: the database refuses a pointer into another workspace.
    foreignKey({
      name: "note_comments_note_fk",
      columns: [t.workspaceId, t.noteId],
      foreignColumns: [notes.workspaceId, notes.id],
    }),
    index("note_comments_workspace_id_note_id_idx").on(t.workspaceId, t.noteId),
  ],
);

// Action ledger. One row per external effect; the row is the only source of truth for
// its state, and every state change bumps version, the claim token.

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const actions = pgTable(
  "actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    capability: text("capability").notNull(),
    dedupeClass: text("dedupe_class").notNull(),
    state: text("state").notNull(),
    holdReason: text("hold_reason"),
    blockReason: text("block_reason"),
    reasonDetail: text("reason_detail"),
    /** For a refusal because of the account's plan, the plan it needs, such as "Pro" (ADR 0028 rule 002). */
    reasonPlan: text("reason_plan"),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    draftVersion: integer("draft_version").notNull().default(1),
    spec: jsonb("spec").notNull(),
    specHash: text("spec_hash").notNull(),
    dueAt: tz("due_at"),
    approvalRequestedAt: tz("approval_requested_at"),
    retries: integer("retries").notNull().default(0),
    nextAttemptAt: tz("next_attempt_at"),
    firstDispatchedAt: tz("first_dispatched_at"),
    correlationKey: text("correlation_key"),
    providerRef: text("provider_ref"),
    // What a sent effect reported beyond its id: a public link, follow-up results.
    result: jsonb("result"),
    dispatchStartedAt: tz("dispatch_started_at"),
    // Set when a call may have gone out, and kept through later holds until the outcome is settled.
    outcomeUnknownAt: tz("outcome_unknown_at"),
    decideBy: tz("decide_by"),
    snoozedUntil: tz("snoozed_until"),
    // The mailbox or key this action sends through; the approval binds its version.
    credentialId: uuid("credential_id"),
    createdAt: tz("created_at").notNull(),
    updatedAt: tz("updated_at").notNull(),
  },
  (t) => [
    unique("actions_workspace_id_id_key").on(t.workspaceId, t.id),
    foreignKey({
      name: "actions_credential_fk",
      columns: [t.workspaceId, t.credentialId],
      foreignColumns: [credentials.workspaceId, credentials.id],
    }),
    unique("actions_workspace_id_idempotency_key_key").on(t.workspaceId, t.idempotencyKey),
    check("actions_dedupe_class_check", sql`${t.dedupeClass} in ('provider_idempotent', 'queryable', 'blind')`),
    check(
      "actions_state_check",
      sql`${t.state} in ('draft', 'needs_approval', 'scheduled', 'claimed', 'dispatching', 'sent', 'held', 'blocked', 'cancelled')`,
    ),
    check("actions_hold_reason_check", sql`(${t.state} = 'held') = (${t.holdReason} is not null)`),
    check("actions_block_reason_check", sql`(${t.state} = 'blocked') = (${t.blockReason} is not null)`),
  ],
);

// Approvals are history: never deleted, and only voided_at may change (grants in 0005).
export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    actionId: uuid("action_id").notNull(),
    draftVersion: integer("draft_version").notNull(),
    specHash: text("spec_hash").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    approverId: uuid("approver_id").notNull(),
    approvedAt: tz("approved_at").notNull(),
    keyId: text("key_id").notNull(),
    signature: text("signature").notNull(),
    voidedAt: tz("voided_at"),
    // Its foreign key is in the migration, since schema-rules imports this file.
    standingRuleId: uuid("standing_rule_id"),
    // Set only by an agent-written rule: which drafter wrote the words and which check record passed them.
    producerDigest: text("producer_digest"),
  },
  (t) => [
    unique("approvals_workspace_id_id_key").on(t.workspaceId, t.id),
    foreignKey({
      name: "approvals_action_fk",
      columns: [t.workspaceId, t.actionId],
      foreignColumns: [actions.workspaceId, actions.id],
    }),
    // At most one live approval per Action; revising voids it first.
    uniqueIndex("approvals_one_live_per_action").on(t.workspaceId, t.actionId).where(sql`${t.voidedAt} is null`),
  ],
);

// Append-only audit of every ledger state change. Exactly one actor: a person, an agent run or the system.
export const actionEvents = pgTable(
  "action_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid("workspace_id").notNull(),
    actionId: uuid("action_id").notNull(),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    reason: text("reason"),
    detail: text("detail"),
    version: bigint("version", { mode: "number" }).notNull(),
    dispatchGapMs: integer("dispatch_gap_ms"),
    actorUserId: uuid("actor_user_id"),
    actorAgentRunId: uuid("actor_agent_run_id"),
    actorSystem: text("actor_system"),
    at: tz("at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "action_events_action_fk",
      columns: [t.workspaceId, t.actionId],
      foreignColumns: [actions.workspaceId, actions.id],
    }),
    index("action_events_workspace_id_action_id_idx").on(t.workspaceId, t.actionId),
    check(
      "action_events_one_actor_check",
      sql`num_nonnulls(${t.actorUserId}, ${t.actorAgentRunId}, ${t.actorSystem}) = 1`,
    ),
  ],
);

// Plugin triggers. Event ids seen per workspace, plugin, trigger and scope, so a webhook retry
// or an overlapping poll hands an event off once. No payload is stored. The scope is the credential
// a poll runs with, or empty for a trigger with none; a primary key can't hold a null.
// ponytail: rows are never pruned; add a retention job on received_at when volume matters.
export const triggerEvents = pgTable(
  "trigger_events",
  {
    workspaceId: uuid("workspace_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    trigger: text("trigger").notNull(),
    scope: text("scope").notNull().default(""),
    eventId: text("event_id").notNull(),
    receivedAt: tz("received_at").notNull(),
  },
  (t) => [primaryKey({ name: "trigger_events_pkey", columns: [t.workspaceId, t.pluginId, t.trigger, t.scope, t.eventId] })],
);

// Where each poll trigger left off, advanced only with a version compare.
export const triggerCursors = pgTable(
  "trigger_cursors",
  {
    workspaceId: uuid("workspace_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    trigger: text("trigger").notNull(),
    scope: text("scope").notNull().default(""),
    cursor: text("cursor").notNull(),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    updatedAt: tz("updated_at").notNull(),
  },
  (t) => [primaryKey({ name: "trigger_cursors_pkey", columns: [t.workspaceId, t.pluginId, t.trigger, t.scope] })],
);

// A Workspace owner's yes to an installed third-party plugin (ADR 0026 rule 002). It counts only
// while install_id and permission_hash still match system.plugin_installs: a reinstall gets a new
// install_id and a change to what the plugin may do or reach a new hash, so either asks again.
export const workspacePlugins = pgTable(
  "workspace_plugins",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.workspaceId),
    pluginId: text("plugin_id").notNull(),
    installId: uuid("install_id").notNull(),
    permissionHash: text("permission_hash").notNull(),
    enabledBy: uuid("enabled_by")
      .notNull()
      .references(() => user.id),
    enabledAt: tz("enabled_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "workspace_plugins_pkey", columns: [t.workspaceId, t.pluginId] }),
    check("workspace_plugins_hash_check", sql`${t.permissionHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

// People. A Person record and the keys it is known by. Records that share a key form a
// Person group, named by coordination_id: the lowest id among records joined by a
// proposed or merged link. The coordination rules lock that one row for the group.
export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    coordinationId: uuid("coordination_id").notNull(),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    unique("people_workspace_id_id_key").on(t.workspaceId, t.id),
    foreignKey({
      name: "people_coordination_fk",
      columns: [t.workspaceId, t.coordinationId],
      foreignColumns: [t.workspaceId, t.id],
    }),
    index("people_workspace_id_coordination_id_idx").on(t.workspaceId, t.coordinationId),
  ],
);

// Not unique across people: a key two records share is how a merge candidate appears.
export const personKeys = pgTable(
  "person_keys",
  {
    workspaceId: uuid("workspace_id").notNull(),
    personId: uuid("person_id").notNull(),
    kind: text("kind").notNull(),
    value: text("value").notNull(),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "person_keys_pkey", columns: [t.workspaceId, t.personId, t.kind, t.value] }),
    foreignKey({
      name: "person_keys_person_fk",
      columns: [t.workspaceId, t.personId],
      foreignColumns: [people.workspaceId, people.id],
    }),
    index("person_keys_workspace_id_kind_value_idx").on(t.workspaceId, t.kind, t.value),
    check("person_keys_kind_check", sql`${t.kind} in ('email', 'phone', 'linkedin', 'x', 'hubspot', 'shopify')`),
  ],
);

// What a Person is to the Workspace, such as one of its own customers, with the name and company the
// list that added the role gave. One row per Person and role; a later import changes only the name and company.
export const personRoles = pgTable(
  "person_roles",
  {
    workspaceId: uuid("workspace_id").notNull(),
    personId: uuid("person_id").notNull(),
    role: text("role").notNull(),
    name: text("name"),
    company: text("company"),
    addedBy: uuid("added_by")
      .notNull()
      .references(() => user.id),
    at: tz("at").notNull(),
  },
  (t) => [
    primaryKey({ name: "person_roles_pkey", columns: [t.workspaceId, t.personId, t.role] }),
    foreignKey({ name: "person_roles_person_fk", columns: [t.workspaceId, t.personId], foreignColumns: [people.workspaceId, people.id] }),
    index("person_roles_workspace_id_role_idx").on(t.workspaceId, t.role),
    check("person_roles_role_check", sql`${t.role} in ('customer')`),
    check("person_roles_name_check", sql`length(${t.name}) <= 200`),
    check("person_roles_company_check", sql`length(${t.company}) <= 200`),
  ],
);

// One row per distinct key value in a workspace. addKey locks it before looking for other
// records with the key, so two records given the same key at once always find each other.
export const identityKeys = pgTable(
  "identity_keys",
  {
    workspaceId: uuid("workspace_id").notNull(),
    kind: text("kind").notNull(),
    value: text("value").notNull(),
  },
  (t) => [primaryKey({ name: "identity_keys_pkey", columns: [t.workspaceId, t.kind, t.value] })],
);

// A merge candidate between two records, and what a person decided about it.
export const personLinks = pgTable(
  "person_links",
  {
    workspaceId: uuid("workspace_id").notNull(),
    lowId: uuid("low_id").notNull(),
    highId: uuid("high_id").notNull(),
    state: text("state").notNull(),
    decidedByUserId: uuid("decided_by_user_id"),
    decidedAt: tz("decided_at"),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "person_links_pkey", columns: [t.workspaceId, t.lowId, t.highId] }),
    foreignKey({ name: "person_links_low_fk", columns: [t.workspaceId, t.lowId], foreignColumns: [people.workspaceId, people.id] }),
    foreignKey({ name: "person_links_high_fk", columns: [t.workspaceId, t.highId], foreignColumns: [people.workspaceId, people.id] }),
    index("person_links_workspace_id_high_id_idx").on(t.workspaceId, t.highId),
    check("person_links_order_check", sql`${t.lowId} < ${t.highId}`),
    check("person_links_state_check", sql`${t.state} in ('proposed', 'merged', 'rejected')`),
    check("person_links_decided_check", sql`(${t.state} = 'proposed') = (${t.decidedAt} is null)`),
  ],
);

// A Touch's claim on a slot, one row per cap it counts against. Whether it still counts
// is derived from its Action's live state, so rows are never updated or deleted.
export const touchReservations = pgTable(
  "touch_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    actionId: uuid("action_id").notNull(),
    personId: uuid("person_id").notNull(),
    touchClass: text("touch_class").notNull(),
    cap: text("cap").notNull(),
    slot: tz("slot").notNull(),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "touch_reservations_action_fk",
      columns: [t.workspaceId, t.actionId],
      foreignColumns: [actions.workspaceId, actions.id],
    }),
    foreignKey({
      name: "touch_reservations_person_fk",
      columns: [t.workspaceId, t.personId],
      foreignColumns: [people.workspaceId, people.id],
    }),
    index("touch_reservations_workspace_id_person_id_slot_idx").on(t.workspaceId, t.personId, t.slot),
    check("touch_reservations_class_check", sql`${t.touchClass} in ('cold', 'sales_follow_up', 'consented_marketing')`),
    check("touch_reservations_cap_check", sql`${t.cap} in ('general', 'consented_marketing')`),
  ],
);

// Organizations and Workspaces. A Workspace is a tenant like any other: workspace_id is a
// generated copy of id, so the forced-RLS catalog check and paired foreign keys apply
// unchanged. An Organization holds no tenant data and is visible only through a Workspace
// the reader can see.
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: tz("created_at").notNull(),
});

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .generatedAlwaysAs(sql`id`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    // The day a Mailbox's daily limit counts in, and when its sending hours fall. An IANA name.
    timeZone: text("time_zone").notNull().default("UTC"),
    createdAt: tz("created_at").notNull(),
    deletedAt: tz("deleted_at"),
    // Set once by system.purge_start and never cleared; withWorkspace refuses the Workspace from then on (ADR 0030 rule 007).
    purgingAt: tz("purging_at"),
  },
  (t) => [unique("workspaces_workspace_id_key").on(t.workspaceId), index("workspaces_org_id_idx").on(t.orgId)],
);

const ROLE_CHECK = sql.raw(`('owner', 'admin', 'marketer', 'contributor', 'viewer')`);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "workspace_members_pkey", columns: [t.workspaceId, t.userId] }),
    foreignKey({
      name: "workspace_members_workspace_fk",
      columns: [t.workspaceId],
      foreignColumns: [workspaces.workspaceId],
    }),
    index("workspace_members_user_id_idx").on(t.userId),
    check("workspace_members_role_check", sql`${t.role} in ${ROLE_CHECK}`),
  ],
);

// The token is shown once in the invite link; only its SHA-256 is stored.
export const workspaceInvites = pgTable(
  "workspace_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    email: text("email").notNull(),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => user.id),
    expiresAt: tz("expires_at").notNull(),
    acceptedAt: tz("accepted_at"),
    revokedAt: tz("revoked_at"),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    unique("workspace_invites_token_hash_key").on(t.tokenHash),
    foreignKey({
      name: "workspace_invites_workspace_fk",
      columns: [t.workspaceId],
      foreignColumns: [workspaces.workspaceId],
    }),
    index("workspace_invites_workspace_id_idx").on(t.workspaceId),
    uniqueIndex("workspace_invites_one_pending")
      .on(t.workspaceId, t.email)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
    check("workspace_invites_role_check", sql`${t.role} in ${ROLE_CHECK}`),
    check("workspace_invites_email_lower_check", sql`${t.email} = lower(${t.email})`),
  ],
);

// Append-only audit of membership changes and External tokens. Exactly one actor: a person or the system.
export const workspaceAudit = pgTable(
  "workspace_audit",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid("workspace_id").notNull(),
    event: text("event").notNull(),
    subjectUserId: uuid("subject_user_id"),
    subjectEmail: text("subject_email"),
    fromRole: text("from_role"),
    toRole: text("to_role"),
    stepUp: boolean("step_up").notNull().default(false),
    // An External token the event is about (ADR 0032 rule 011); no FK, since schema-door imports this file.
    subjectTokenId: uuid("subject_token_id"),
    actorUserId: uuid("actor_user_id"),
    actorSystem: text("actor_system"),
    at: tz("at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "workspace_audit_workspace_fk",
      columns: [t.workspaceId],
      foreignColumns: [workspaces.workspaceId],
    }),
    index("workspace_audit_workspace_id_at_idx").on(t.workspaceId, t.at),
    check("workspace_audit_one_actor_check", sql`num_nonnulls(${t.actorUserId}, ${t.actorSystem}) = 1`),
  ],
);

// Credential vault. Each Workspace has one active data key, wrapped by the root key; a
// credential's value is sealed with it, bound to the row by its AAD. No value or token is
// ever stored in the clear, and access events hold no value.
export const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
/** A 64-bit transaction id, read as a decimal string; it never wraps around. */
export const xid8 = customType<{ data: string }>({ dataType: () => "xid8" });

export const workspaceKeys = pgTable(
  "workspace_keys",
  {
    workspaceId: uuid("workspace_id").notNull(),
    keyVersion: integer("key_version").notNull(),
    wrappedDek: bytea("wrapped_dek").notNull(),
    rootKeyId: text("root_key_id").notNull(),
    createdAt: tz("created_at").notNull(),
    retiredAt: tz("retired_at"),
  },
  (t) => [
    primaryKey({ name: "workspace_keys_pkey", columns: [t.workspaceId, t.keyVersion] }),
    foreignKey({
      name: "workspace_keys_workspace_fk",
      columns: [t.workspaceId],
      foreignColumns: [workspaces.workspaceId],
    }),
    uniqueIndex("workspace_keys_one_active").on(t.workspaceId).where(sql`${t.retiredAt} is null`),
  ],
);

export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    scope: text("scope").notNull(),
    ownerUserId: uuid("owner_user_id").references(() => user.id),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    connection: text("connection"),
    meta: jsonb("meta").notNull().default({}),
    status: text("status").notNull().default("active"),
    ciphertext: bytea("ciphertext"),
    nonce: bytea("nonce"),
    keyVersion: integer("key_version").notNull(),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    expiresAt: tz("expires_at"),
    createdBy: uuid("created_by").references(() => user.id),
    createdAt: tz("created_at").notNull(),
    updatedAt: tz("updated_at").notNull(),
    lastUsedAt: tz("last_used_at"),
    lastRotatedAt: tz("last_rotated_at"),
    deletedAt: tz("deleted_at"),
    // A Mailbox's pace: how many emails a day, and the hours (minutes from midnight, Workspace time)
    // they go out in. Columns, not meta: meta feeds the header check's settings hash.
    dailyLimit: integer("daily_limit").notNull().default(50),
    sendFrom: integer("send_from").notNull().default(540),
    sendUntil: integer("send_until").notNull().default(1020),
    sendWeekends: boolean("send_weekends").notNull().default(false),
    // A Mailbox's pause, set by its bounces or by a person; only a person's resume clears it. Sends and
    // bounces from before resumed_at don't count towards the next pause.
    pausedAt: tz("paused_at"),
    pauseReason: text("pause_reason"),
    pausedBy: uuid("paused_by").references(() => user.id),
    resumedAt: tz("resumed_at"),
  },
  (t) => [
    unique("credentials_workspace_id_id_key").on(t.workspaceId, t.id),
    check("credentials_daily_limit_check", sql`${t.dailyLimit} between 1 and 500`),
    check("credentials_pause_check", sql`(${t.pausedAt} is null) = (${t.pauseReason} is null) and ${t.pauseReason} in ('bounces', 'person')`),
    check("credentials_send_hours_check", sql`0 <= ${t.sendFrom} and ${t.sendFrom} < ${t.sendUntil} and ${t.sendUntil} <= 1440`),
    foreignKey({
      name: "credentials_workspace_fk",
      columns: [t.workspaceId],
      foreignColumns: [workspaces.workspaceId],
    }),
    foreignKey({
      name: "credentials_key_fk",
      columns: [t.workspaceId, t.keyVersion],
      foreignColumns: [workspaceKeys.workspaceId, workspaceKeys.keyVersion],
    }),
    uniqueIndex("credentials_workspace_key")
      .on(t.workspaceId, t.key)
      .where(sql`${t.scope} = 'workspace' and ${t.deletedAt} is null`),
    uniqueIndex("credentials_user_key")
      .on(t.workspaceId, t.ownerUserId, t.key)
      .where(sql`${t.scope} = 'user' and ${t.deletedAt} is null`),
    check("credentials_scope_check", sql`${t.scope} in ('workspace', 'user')`),
    check("credentials_owner_check", sql`(${t.scope} = 'user') = (${t.ownerUserId} is not null)`),
    check("credentials_kind_check", sql`${t.kind} in ('oauth2', 'api_key', 'header', 'basic', 'secret')`),
    check(
      "credentials_oauth2_check",
      sql`${t.kind} <> 'oauth2' or (${t.connection} is not null and ${t.scope} = 'user')`,
    ),
    check("credentials_status_check", sql`${t.status} in ('active', 'needs_reauth', 'revoked')`),
    // An operator's command has no signed-in user, and only sets the system Workspace's values.
    check(
      "credentials_created_by_check",
      sql`${t.createdBy} is not null or ${t.workspaceId} = '00000000-0000-4000-8000-00000000d1e0'`,
    ),
    // A deleted row keeps no ciphertext; a live one always has both halves.
    check(
      "credentials_value_check",
      sql`(${t.deletedAt} is null) = (${t.ciphertext} is not null) and (${t.ciphertext} is null) = (${t.nonce} is null)`,
    ),
  ],
);

// A webhook trigger's address in one Workspace (ADR 0031 rule 007). A delivery's URL names this row,
// and the row alone says which plugin and trigger it is for. Its signing secret is a Workspace
// credential, checked inside the vault and never handed to the plugin. One per trigger per Workspace.
export const pluginWebhooks = pgTable(
  "plugin_webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    trigger: text("trigger").notNull(),
    credentialId: uuid("credential_id").notNull(),
    createdAt: tz("created_at").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
  },
  (t) => [
    unique("plugin_webhooks_one_per_trigger").on(t.workspaceId, t.pluginId, t.trigger),
    foreignKey({ name: "plugin_webhooks_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "plugin_webhooks_credential_fk", columns: [t.workspaceId, t.credentialId], foreignColumns: [credentials.workspaceId, credentials.id] }),
  ],
);

// Who changed a Mailbox's limit or hours, and from what to what. Append-only.
export const mailboxSettingChanges = pgTable(
  "mailbox_setting_changes",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid("workspace_id").notNull(),
    credentialId: uuid("credential_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after").notNull(),
    changedBy: uuid("changed_by")
      .notNull()
      .references(() => user.id),
    changedAt: tz("changed_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "mailbox_setting_changes_credential_fk",
      columns: [t.workspaceId, t.credentialId],
      foreignColumns: [credentials.workspaceId, credentials.id],
    }),
    index("mailbox_setting_changes_credential_idx").on(t.workspaceId, t.credentialId, t.changedAt),
  ],
);

// An email's claim on a Mailbox's day. Like touch_reservations: the newest row per Action wins, and
// whether it counts comes from the Action's live state, so rows are never updated or deleted.
export const mailboxReservations = pgTable(
  "mailbox_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    actionId: uuid("action_id").notNull(),
    credentialId: uuid("credential_id").notNull(),
    day: text("day").notNull(),
    slot: tz("slot").notNull(),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "mailbox_reservations_action_fk",
      columns: [t.workspaceId, t.actionId],
      foreignColumns: [actions.workspaceId, actions.id],
    }),
    foreignKey({
      name: "mailbox_reservations_credential_fk",
      columns: [t.workspaceId, t.credentialId],
      foreignColumns: [credentials.workspaceId, credentials.id],
    }),
    index("mailbox_reservations_day_idx").on(t.workspaceId, t.credentialId, t.day),
    index("mailbox_reservations_action_idx").on(t.workspaceId, t.actionId, t.createdAt),
    check("mailbox_reservations_day_check", sql`${t.day} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
  ],
);

// A link one person makes to connect an account from a device where Direx isn't signed in. Only the
// token's SHA-256 is kept. Claiming it stores the sealed OAuth state that a connect from a signed-in
// browser keeps in a cookie, found again by the SHA-256 of `state` when the network calls back.
export const connectLinks = pgTable(
  "connect_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    issuedBy: uuid("issued_by")
      .notNull()
      .references(() => user.id),
    connection: text("connection").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: tz("expires_at").notNull(),
    claimedAt: tz("claimed_at"),
    stateHash: text("state_hash"),
    sealedState: text("sealed_state"),
    usedAt: tz("used_at"),
    credentialId: uuid("credential_id"),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    unique("connect_links_token_hash_key").on(t.tokenHash),
    unique("connect_links_state_hash_key").on(t.stateHash),
    foreignKey({ name: "connect_links_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "connect_links_credential_fk", columns: [t.workspaceId, t.credentialId], foreignColumns: [credentials.workspaceId, credentials.id] }),
    index("connect_links_issuer_idx").on(t.workspaceId, t.issuedBy, t.createdAt),
  ],
);

export const credentialAccessEvents = pgTable(
  "credential_access_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid("workspace_id").notNull(),
    credentialId: uuid("credential_id").notNull(),
    consumer: text("consumer").notNull(),
    actionId: uuid("action_id"),
    actorUserId: uuid("actor_user_id"),
    outcome: text("outcome").notNull(),
    errorCode: text("error_code"),
    at: tz("at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "credential_access_events_credential_fk",
      columns: [t.workspaceId, t.credentialId],
      foreignColumns: [credentials.workspaceId, credentials.id],
    }),
    foreignKey({
      name: "credential_access_events_action_fk",
      columns: [t.workspaceId, t.actionId],
      foreignColumns: [actions.workspaceId, actions.id],
    }),
    index("credential_access_events_credential_at_idx").on(t.workspaceId, t.credentialId, t.at),
    check(
      "credential_access_events_consumer_check",
      sql`${t.consumer} in ('execute', 'reconcile', 'query', 'poll', 'model_call', 'mcp_call', 'startup', 'webhook', 'create', 'rotate', 'connect', 'disconnect', 'delete')`,
    ),
    check(
      "credential_access_events_outcome_check",
      sql`${t.outcome} in ('ok', 'refreshed', 'needs_reauth', 'refused', 'error')`,
    ),
  ],
);

// One row per Item. An Action's state, reasons and triage stay on its actions row, so an
// Action Item has none here and can never disagree with the ledger. Only a non-Action Item,
// such as a fact edit, keeps them on this table.
export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    kind: text("kind").notNull(),
    actionId: uuid("action_id"),
    state: text("state"),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    // The draft version these details describe; behind the Action's means not clean.
    describedDraftVersion: integer("described_draft_version"),
    title: text("title").notNull(),
    workArea: text("work_area"),
    channel: text("channel"),
    groupKey: text("group_key"),
    groupLabel: text("group_label"),
    plannedAt: tz("planned_at"),
    warnings: jsonb("warnings").notNull(),
    // Why a standing rule left this waiting. Not a warning: a person can still approve it in bulk.
    ruleNote: text("rule_note"),
    snapshot: jsonb("snapshot").notNull().default([]),
    payload: jsonb("payload"),
    decideBy: tz("decide_by"),
    snoozedUntil: tz("snoozed_until"),
    createdAt: tz("created_at").notNull(),
    updatedAt: tz("updated_at").notNull(),
  },
  (t) => [
    unique("items_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("items_workspace_id_action_id_key").on(t.workspaceId, t.actionId),
    foreignKey({
      name: "items_workspace_fk",
      columns: [t.workspaceId],
      foreignColumns: [workspaces.workspaceId],
    }),
    foreignKey({
      name: "items_action_fk",
      columns: [t.workspaceId, t.actionId],
      foreignColumns: [actions.workspaceId, actions.id],
    }),
    index("items_workspace_id_planned_at_idx").on(t.workspaceId, t.plannedAt),
    index("items_workspace_id_created_at_idx").on(t.workspaceId, t.createdAt),
    check("items_kind_check", sql`(${t.kind} = 'action') = (${t.actionId} is not null)`),
    check("items_one_state_check", sql`(${t.actionId} is null) = (${t.state} is not null)`),
    check("items_state_check", sql`${t.state} in ('draft', 'needs_approval', 'scheduled', 'applied', 'cancelled')`),
    check("items_described_version_check", sql`(${t.actionId} is null) = (${t.describedDraftVersion} is null)`),
    check("items_triage_check", sql`${t.actionId} is null or (${t.decideBy} is null and ${t.snoozedUntil} is null)`),
    check("items_warnings_check", sql`jsonb_typeof(${t.warnings}) = 'array'`),
    // Each warning is a code a rule can read and the words a person reads.
    check("items_warnings_shape_check", sql`not jsonb_path_exists(${t.warnings}, '$[*] ? (@.type() != "object" || !(@.code.type() == "string") || !(@.text.type() == "string"))')`),
  ],
);

// Append-only history of non-Action Items; an Action's history is in action_events.
export const itemEvents = pgTable(
  "item_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid("workspace_id").notNull(),
    itemId: uuid("item_id").notNull(),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    detail: text("detail"),
    version: bigint("version", { mode: "number" }).notNull(),
    actorUserId: uuid("actor_user_id").references(() => user.id),
    actorAgentRunId: uuid("actor_agent_run_id"),
    actorSystem: text("actor_system"),
    at: tz("at").notNull(),
    // The writing transaction, so a reader of changes can wait for older ones to finish (door-reads).
    // Rows from before it existed hold 0. ponytail: no (workspace_id, tx, id) index yet, so the feed scans
    // one Workspace's events per read; add it in a no-transaction migration once migrate-parity.test.ts
    // can compare a marked file, which drizzle's own migrator can't run (ADR 0029).
    tx: xid8("tx").notNull().default(sql`pg_current_xact_id()`),
  },
  (t) => [
    foreignKey({
      name: "item_events_item_fk",
      columns: [t.workspaceId, t.itemId],
      foreignColumns: [items.workspaceId, items.id],
    }),
    index("item_events_workspace_id_item_id_idx").on(t.workspaceId, t.itemId),
    check("item_events_one_actor_check", sql`num_nonnulls(${t.actorUserId}, ${t.actorAgentRunId}, ${t.actorSystem}) = 1`),
  ],
);

// One row per approve, edit-and-approve or reject a person made on an Item, with how long it was open and
// how much they changed. Read only for that person's own review rates. Skips are not recorded.
export const reviewDecisions = pgTable(
  "review_decisions",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid("workspace_id").notNull(),
    itemId: uuid("item_id").notNull(),
    reviewerId: uuid("reviewer_id")
      .notNull()
      .references(() => user.id),
    kind: text("kind").notNull(),
    decision: text("decision").notNull(),
    // The Campaign step a per-Person draft belongs to, so repeated edits are counted per step.
    campaignId: uuid("campaign_id"),
    stepKey: text("step_key"),
    openedAt: tz("opened_at").notNull(),
    decidedAt: tz("decided_at").notNull(),
    editDistance: integer("edit_distance"),
    editPhrases: text("edit_phrases").array().notNull().default(sql`'{}'::text[]`),
    // Why a person turned a draft down ("Not like this"), or `great` for praise on approve, with their optional
    // sentence. Counted per step to offer a writer note; praise is kept but not used yet.
    reason: text("reason"),
    reasonNote: text("reason_note"),
  },
  (t) => [
    foreignKey({ name: "review_decisions_item_fk", columns: [t.workspaceId, t.itemId], foreignColumns: [items.workspaceId, items.id] }),
    index("review_decisions_reviewer_idx").on(t.workspaceId, t.reviewerId, t.decidedAt),
    index("review_decisions_step_idx").on(t.workspaceId, t.campaignId, t.stepKey),
    check("review_decisions_step_check", sql`(${t.campaignId} is null) = (${t.stepKey} is null)`),
    check("review_decisions_decision_check", sql`${t.decision} in ('approve', 'edit_approve', 'reject', 'rewrite')`),
    check("review_decisions_reason_check", sql`${t.reason} in ('salesy', 'long', 'facts', 'voice', 'audience', 'great')`),
    check("review_decisions_reason_note_check", sql`char_length(${t.reasonNote}) <= 300`),
    check("review_decisions_times_check", sql`${t.openedAt} <= ${t.decidedAt}`),
  ],
);

// Spend in integer micro-dollars. A month's spend is settled plus held, by created_at.
export const budgetReservations = pgTable(
  "budget_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    kind: text("kind").notNull(),
    reservedMicros: bigint("reserved_micros", { mode: "bigint" }).notNull(),
    settledMicros: bigint("settled_micros", { mode: "bigint" }),
    status: text("status").notNull().default("held"),
    createdAt: tz("created_at").notNull(),
    settledAt: tz("settled_at"),
  },
  (t) => [
    unique("budget_reservations_workspace_id_id_key").on(t.workspaceId, t.id),
    foreignKey({
      name: "budget_reservations_workspace_fk",
      columns: [t.workspaceId],
      foreignColumns: [workspaces.workspaceId],
    }),
    index("budget_reservations_workspace_id_kind_created_at_idx").on(t.workspaceId, t.kind, t.createdAt),
    check("budget_reservations_kind_check", sql`${t.kind} in ('model')`),
    check("budget_reservations_status_check", sql`${t.status} in ('held', 'settled', 'released')`),
    check("budget_reservations_settled_check", sql`(${t.status} = 'settled') = (${t.settledMicros} is not null)`),
  ],
);

// One row per attempt. There is deliberately no column for prompt or response text.
export const modelCalls = pgTable(
  "model_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    actorUserId: uuid("actor_user_id").references(() => user.id),
    runId: uuid("run_id"),
    purpose: text("purpose").notNull(),
    routeHash: text("route_hash"),
    provider: text("provider"),
    requestedModel: text("requested_model"),
    resolvedModel: text("resolved_model"),
    credentialKind: text("credential_kind"),
    trust: text("trust").notNull(),
    untrustedSources: jsonb("untrusted_sources").notNull().default([]),
    toolsOffered: text("tools_offered").array().notNull().default(sql`'{}'`),
    attempt: integer("attempt").notNull().default(0),
    status: text("status").notNull(),
    refusal: text("refusal"),
    errorFamily: text("error_family"),
    providerRequestId: text("provider_request_id"),
    inputTokens: integer("input_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    outputTokens: integer("output_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    reservationId: uuid("reservation_id"),
    costMicros: bigint("cost_micros", { mode: "bigint" }),
    costStatus: text("cost_status"),
    pricingProvenance: text("pricing_provenance"),
    overReserved: boolean("over_reserved").notNull().default(false),
    createdAt: tz("created_at").notNull(),
    settledAt: tz("settled_at"),
  },
  (t) => [
    unique("model_calls_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("model_calls_workspace_id_idempotency_key_key").on(t.workspaceId, t.idempotencyKey),
    foreignKey({
      name: "model_calls_workspace_fk",
      columns: [t.workspaceId],
      foreignColumns: [workspaces.workspaceId],
    }),
    foreignKey({
      name: "model_calls_reservation_fk",
      columns: [t.workspaceId, t.reservationId],
      foreignColumns: [budgetReservations.workspaceId, budgetReservations.id],
    }),
    index("model_calls_workspace_id_created_at_idx").on(t.workspaceId, t.createdAt),
    // The budget reservation sweep's NOT EXISTS and the foreign key check on each reservation it deletes.
    index("model_calls_workspace_id_reservation_id_idx").on(t.workspaceId, t.reservationId),
    index("model_calls_workspace_id_run_id_idx").on(t.workspaceId, t.runId),
    check("model_calls_status_check", sql`${t.status} in ('dispatched', 'completed', 'failed', 'refused')`),
    check("model_calls_refused_check", sql`(${t.status} = 'refused') = (${t.refusal} is not null)`),
    check("model_calls_trust_check", sql`${t.trust} in ('trusted', 'untrusted')`),
    check("model_calls_credential_kind_check", sql`${t.credentialKind} in ('cloud_contract', 'byok_api_key', 'openrouter', 'cli_subscription')`),
    check("model_calls_cost_status_check", sql`${t.costStatus} in ('reported', 'estimated', 'unpriced', 'unknown', 'subscription')`),
  ],
);

export const modelConnections = pgTable(
  "model_connections",
  {
    workspaceId: uuid("workspace_id").notNull(),
    provider: text("provider").notNull(),
    credentialId: uuid("credential_id").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.provider] }),
    foreignKey({
      name: "model_connections_workspace_fk",
      columns: [t.workspaceId],
      foreignColumns: [workspaces.workspaceId],
    }),
    foreignKey({
      name: "model_connections_credential_fk",
      columns: [t.workspaceId, t.credentialId],
      foreignColumns: [credentials.workspaceId, credentials.id],
    }),
    check("model_connections_provider_check", sql`${t.provider} in ('anthropic', 'openai', 'google', 'openrouter')`),
  ],
);

// Insert only: the latest row is the setting, and no row means the defaults.
export const modelSettingsRevisions = pgTable(
  "model_settings_revisions",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid("workspace_id").notNull(),
    monthlyBudgetMicros: bigint("monthly_budget_micros", { mode: "bigint" }).notNull(),
    allowUnpriced: boolean("allow_unpriced").notNull(),
    adapter: text("adapter"),
    adapterModel: text("adapter_model"),
    changedBy: uuid("changed_by")
      .notNull()
      .references(() => user.id),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "model_settings_revisions_workspace_fk",
      columns: [t.workspaceId],
      foreignColumns: [workspaces.workspaceId],
    }),
    index("model_settings_revisions_workspace_id_id_idx").on(t.workspaceId, t.id),
    check("model_settings_revisions_budget_check", sql`${t.monthlyBudgetMicros} > 0`),
  ],
);

export const agentModelChoices = pgTable(
  "agent_model_choices",
  {
    workspaceId: uuid("workspace_id").notNull(),
    agent: text("agent").notNull(),
    adapter: text("adapter").notNull(),
    adapterModel: text("adapter_model"),
    changedBy: uuid("changed_by")
      .notNull()
      .references(() => user.id),
    changedAt: tz("changed_at").notNull(),
    /** Set when a cloud run found the choice without a passing eval and fell back; cleared when it passes again. */
    pausedAt: tz("paused_at"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.agent] }),
    foreignKey({
      name: "agent_model_choices_workspace_fk",
      columns: [t.workspaceId],
      foreignColumns: [workspaces.workspaceId],
    }),
  ],
);

/** Every set and clear of an agent's choice, append-only. A null adapter is a clear. */
export const agentModelChoiceRevisions = pgTable(
  "agent_model_choice_revisions",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid("workspace_id").notNull(),
    agent: text("agent").notNull(),
    adapter: text("adapter"),
    adapterModel: text("adapter_model"),
    changedBy: uuid("changed_by")
      .notNull()
      .references(() => user.id),
    changedAt: tz("changed_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "agent_model_choice_revisions_workspace_fk",
      columns: [t.workspaceId],
      foreignColumns: [workspaces.workspaceId],
    }),
    index("agent_model_choice_revisions_workspace_id_agent_id_idx").on(t.workspaceId, t.agent, t.id),
  ],
);

export const modelCliSignIns = pgTable(
  "model_cli_sign_ins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    provider: text("provider").notNull(),
    /** Null is shared with the Workspace. */
    ownerUserId: uuid("owner_user_id").references(() => user.id),
    credentialId: uuid("credential_id").notNull(),
    /** The open Needs you entry saying this sign-in stopped working. */
    needsItemId: uuid("needs_item_id"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    unique("model_cli_sign_ins_one_key").on(t.workspaceId, t.provider, t.ownerUserId).nullsNotDistinct(),
    foreignKey({
      name: "model_cli_sign_ins_workspace_fk",
      columns: [t.workspaceId],
      foreignColumns: [workspaces.workspaceId],
    }),
    foreignKey({
      name: "model_cli_sign_ins_credential_fk",
      columns: [t.workspaceId, t.credentialId],
      foreignColumns: [credentials.workspaceId, credentials.id],
    }),
    check("model_cli_sign_ins_provider_check", sql`${t.provider} in ('claude_code', 'codex')`),
  ],
);

export const modelBudgetIncidents = pgTable(
  "model_budget_incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    month: text("month").notNull(),
    threshold: integer("threshold").notNull(),
    openedAt: tz("opened_at").notNull(),
  },
  (t) => [
    unique("model_budget_incidents_workspace_month_threshold_key").on(t.workspaceId, t.month, t.threshold),
    foreignKey({
      name: "model_budget_incidents_workspace_fk",
      columns: [t.workspaceId],
      foreignColumns: [workspaces.workspaceId],
    }),
    check("model_budget_incidents_threshold_check", sql`${t.threshold} in (80, 100)`),
  ],
);

// The root key this deployment first ran with: its id only, never the key. One row, no
// Workspace, so a start can tell a lost or different key from a first run.
export const deploymentRootKey = pgTable(
  "deployment_root_key",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    rootKeyId: text("root_key_id").notNull(),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [check("deployment_root_key_singleton_check", sql`${t.singleton}`)],
);

// Each Workspace's keys for signing approvals, sealed under its data key. Apart from
// credentials on purpose: no credential route, plugin lookup or agent path can name one.
export const approvalKeys = pgTable(
  "approval_keys",
  {
    workspaceId: uuid("workspace_id").notNull(),
    keyId: text("key_id").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    nonce: bytea("nonce").notNull(),
    keyVersion: integer("key_version").notNull(),
    createdAt: tz("created_at").notNull(),
    retiredAt: tz("retired_at"),
  },
  (t) => [
    primaryKey({ name: "approval_keys_pkey", columns: [t.workspaceId, t.keyId] }),
    foreignKey({
      name: "approval_keys_workspace_fk",
      columns: [t.workspaceId],
      foreignColumns: [workspaces.workspaceId],
    }),
    uniqueIndex("approval_keys_one_live").on(t.workspaceId).where(sql`${t.retiredAt} is null`),
  ],
);

// Business context. A fact fills one slot, a field and a subject; its words live in
// versions, which are never changed, so fact_id@version always means the same thing.
export const facts = pgTable(
  "facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    field: text("field").notNull(),
    subject: text("subject").notNull().default(""),
    currentVersion: integer("current_version").notNull(),
    retiredAt: tz("retired_at"),
    retiredBy: uuid("retired_by").references(() => user.id),
    createdAt: tz("created_at").notNull(),
    updatedAt: tz("updated_at").notNull(),
  },
  (t) => [
    unique("facts_workspace_id_id_key").on(t.workspaceId, t.id),
    foreignKey({ name: "facts_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    uniqueIndex("facts_one_live_per_slot").on(t.workspaceId, t.field, t.subject).where(sql`${t.retiredAt} is null`),
    check("facts_field_check", sql`${t.field} in ('what_you_sell', 'who_buys', 'tone', 'price', 'claim', 'never_say', 'competitor')`),
  ],
);

export const factVersions = pgTable(
  "fact_versions",
  {
    workspaceId: uuid("workspace_id").notNull(),
    factId: uuid("fact_id").notNull(),
    version: integer("version").notNull(),
    value: text("value").notNull(),
    source: jsonb("source").notNull(),
    confidence: text("confidence").notNull(),
    digest: text("digest").notNull(),
    actorUserId: uuid("actor_user_id").references(() => user.id),
    actorAgentRunId: uuid("actor_agent_run_id"),
    actorSystem: text("actor_system"),
    at: tz("at").notNull(),
  },
  (t) => [
    primaryKey({ name: "fact_versions_pkey", columns: [t.workspaceId, t.factId, t.version] }),
    foreignKey({ name: "fact_versions_fact_fk", columns: [t.workspaceId, t.factId], foreignColumns: [facts.workspaceId, facts.id] }),
    check("fact_versions_confidence_check", sql`${t.confidence} in ('low', 'medium', 'high')`),
    check("fact_versions_one_actor_check", sql`num_nonnulls(${t.actorUserId}, ${t.actorAgentRunId}, ${t.actorSystem}) = 1`),
  ],
);

// One calendar feed per member, of review blocks sized to Needs you. The token is shown once in
// the feed URL; only its SHA-256 is stored. Leaving the Workspace deletes the feed.
export const reviewFeeds = pgTable(
  "review_feeds",
  {
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    // ISO weekdays: 1 is Monday, 7 is Sunday.
    weekdays: integer("weekdays").array().notNull(),
    startMinute: integer("start_minute").notNull(),
    lengthMinutes: integer("length_minutes").notNull(),
    timeZone: text("time_zone").notNull(),
    createdAt: tz("created_at").notNull(),
    lastFetchedAt: tz("last_fetched_at"),
    fetchCount: integer("fetch_count").notNull().default(0),
  },
  (t) => [
    primaryKey({ name: "review_feeds_pkey", columns: [t.workspaceId, t.userId] }),
    foreignKey({ name: "review_feeds_member_fk", columns: [t.workspaceId, t.userId], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }).onDelete("cascade"),
    unique("review_feeds_token_hash_key").on(t.tokenHash),
    check("review_feeds_token_hash_check", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("review_feeds_weekdays_check", sql`cardinality(${t.weekdays}) between 1 and 7 and ${t.weekdays} <@ array[1, 2, 3, 4, 5, 6, 7]`),
    check("review_feeds_start_check", sql`${t.startMinute} between 0 and 1439`),
    check("review_feeds_length_check", sql`${t.lengthMinutes} in (15, 30, 60)`),
    check("review_feeds_time_zone_check", sql`${t.timeZone} <> ''`),
  ],
);
