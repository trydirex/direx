// SPDX-License-Identifier: AGPL-3.0-only
// What must hold before an email reaches a Person: who is sending, the emergency pause, who has
// opted out, and the recorded basis for contacting someone.
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { actions, credentials, people, workspaces } from "./schema";

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const outreachSettings = pgTable(
  "outreach_settings",
  {
    workspaceId: uuid("workspace_id").primaryKey(),
    senderName: text("sender_name"),
    postalAddress: text("postal_address"),
    // The sender's own country, since some countries' laws follow mail sent from them.
    senderCountry: text("sender_country"),
    pausedAt: tz("paused_at"),
    pausedBy: uuid("paused_by").references(() => user.id),
    // Random per Workspace, so an address hash from one Workspace matches nothing in another.
    emailHashKey: text("email_hash_key"),
    updatedAt: tz("updated_at").notNull(),
  },
  (t) => [
    foreignKey({ name: "outreach_settings_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    check("outreach_settings_sender_country_check", sql`${t.senderCountry} ~ '^[A-Z]{2}$'`),
  ],
);

// Lowercased, as person_keys stores an email. A suppression is never removed by the product.
export const suppressions = pgTable(
  "suppressions",
  {
    workspaceId: uuid("workspace_id").notNull(),
    email: text("email").notNull(),
    reason: text("reason").notNull(),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.email] }),
    foreignKey({ name: "suppressions_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    check("suppressions_reason_check", sql`${t.reason} in ('unsubscribe', 'manual', 'reply', 'hard_bounce')`),
  ],
);

/**
 * An Owner's undo of an opt-out read from a reply, kept for good. Only the database function that
 * removes the suppression writes here, so the record can't be skipped, edited or faked.
 */
export const suppressionReversals = pgTable(
  "suppression_reversals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    email: text("email").notNull(),
    suppressedAt: tz("suppressed_at").notNull(),
    undoneBy: uuid("undone_by").notNull().references(() => user.id),
    reason: text("reason").notNull(),
    // The reply text that was read as an opt-out, when it is still known.
    quote: text("quote"),
    undoneAt: tz("undone_at").notNull(),
  },
  (t) => [
    index("suppression_reversals_email_idx").on(t.workspaceId, t.email),
    foreignKey({ name: "suppression_reversals_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    check("suppression_reversals_reason_check", sql`length(btrim(${t.reason})) between 1 and 1000`),
  ],
);

// Every address ever seen on a connected newsletter list, lowercased. Anyone here is kept out of
// cold email, so the product never removes a row, even when the tool no longer lists the address.
// Only the address, its last state in the tool and when it was seen are kept.
export const newsletterSubscribers = pgTable(
  "newsletter_subscribers",
  {
    workspaceId: uuid("workspace_id").notNull(),
    credentialId: uuid("credential_id").notNull(),
    email: text("email").notNull(),
    state: text("state").notNull(),
    firstSeenAt: tz("first_seen_at").notNull(),
    lastSeenAt: tz("last_seen_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.credentialId, t.email] }),
    foreignKey({ name: "newsletter_subscribers_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "newsletter_subscribers_credential_fk", columns: [t.workspaceId, t.credentialId], foreignColumns: [credentials.workspaceId, credentials.id] }),
    index("newsletter_subscribers_email_idx").on(t.workspaceId, t.email),
    check("newsletter_subscribers_state_check", sql`${t.state} in ('subscribed', 'unsubscribed', 'bounced', 'complained', 'other')`),
    check("newsletter_subscribers_email_check", sql`${t.email} = lower(${t.email})`),
  ],
);

// Only the token's hash is kept, so reading this table can't unsubscribe anyone.
export const unsubscribeTokens = pgTable(
  "unsubscribe_tokens",
  {
    workspaceId: uuid("workspace_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    email: text("email").notNull(),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.tokenHash] }),
    foreignKey({ name: "unsubscribe_tokens_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
  ],
);

export const personEligibility = pgTable(
  "person_eligibility",
  {
    workspaceId: uuid("workspace_id").notNull(),
    personId: uuid("person_id").notNull(),
    country: text("country").notNull(),
    basis: text("basis").notNull(),
    evidence: text("evidence").notNull(),
    entityType: text("entity_type").notNull().default("unknown"),
    // What the basis covers, such as one product's updates.
    scope: text("scope"),
    // Mail that needs a basis stops on this date. No date means the basis doesn't lapse.
    expiresAt: tz("expires_at"),
    // Stated by a person or a list, or guessed from the company by the lead generator.
    countryConfidence: text("country_confidence").notNull().default("stated"),
    recordedBy: uuid("recorded_by")
      .notNull()
      .references(() => user.id),
    recordedAt: tz("recorded_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.personId] }),
    foreignKey({ name: "person_eligibility_person_fk", columns: [t.workspaceId, t.personId], foreignColumns: [people.workspaceId, people.id] }),
    check("person_eligibility_basis_check", sql`${t.basis} in ('consent', 'implied', 'legitimate_interest', 'published_address')`),
    check("person_eligibility_country_check", sql`${t.country} ~ '^[A-Z]{2}$'`),
    check("person_eligibility_entity_type_check", sql`${t.entityType} in ('corporate', 'sole_trader', 'partnership', 'unknown')`),
    check("person_eligibility_scope_check", sql`length(${t.scope}) <= 500`),
    check("person_eligibility_country_confidence_check", sql`${t.countryConfidence} in ('stated', 'inferred')`),
  ],
);

// One inbound message that might stop mail to someone. Its text is held only until a decision.
export const replySignals = pgTable(
  "reply_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    credentialId: uuid("credential_id"),
    eventId: text("event_id").notNull(),
    senderEmail: text("sender_email").notNull(),
    personId: uuid("person_id"),
    actionId: uuid("action_id"),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    decidedBy: text("decided_by"),
    quote: text("quote"),
    bounceStatus: text("bounce_status"),
    text: text("text"),
    receivedAt: tz("received_at").notNull(),
    decidedAt: tz("decided_at"),
  },
  (t) => [
    unique("reply_signals_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("reply_signals_event_key").on(t.workspaceId, t.credentialId, t.eventId).nullsNotDistinct(),
    index("reply_signals_open_idx").on(t.workspaceId, t.status),
    foreignKey({ name: "reply_signals_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "reply_signals_credential_fk", columns: [t.workspaceId, t.credentialId], foreignColumns: [credentials.workspaceId, credentials.id] }),
    foreignKey({ name: "reply_signals_person_fk", columns: [t.workspaceId, t.personId], foreignColumns: [people.workspaceId, people.id] }),
    foreignKey({ name: "reply_signals_action_fk", columns: [t.workspaceId, t.actionId], foreignColumns: [actions.workspaceId, actions.id] }),
    check("reply_signals_kind_check", sql`${t.kind} in ('reply', 'bounce', 'read_back')`),
    check("reply_signals_status_check", sql`${t.status} in ('pending', 'opted_out', 'not_opt_out', 'needs_person', 'recorded')`),
    check("reply_signals_decided_by_check", sql`${t.decidedBy} in ('rule', 'model', 'person')`),
  ],
);

/**
 * One row per check of whether a Mailbox's provider delivers Direx's opt-out unchanged; the newest row
 * for a credential is its current check. Only core's check code writes here, never a request, and a
 * result counts only for the probe and the Mailbox settings it was made with.
 */
export const mailboxHeaderChecks = pgTable(
  "mailbox_header_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Orders checks by when they were made, even two made in the same instant.
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    workspaceId: uuid("workspace_id").notNull(),
    credentialId: uuid("credential_id").notNull(),
    // None when no probe could be sent, such as a sign-in that isn't an email address.
    probeActionId: uuid("probe_action_id"),
    probeSubject: text("probe_subject"),
    settingsHash: text("settings_hash").notNull(),
    state: text("state").notNull(),
    failures: text("failures").array().notNull().default(sql`'{}'::text[]`),
    warnings: text("warnings").array().notNull().default(sql`'{}'::text[]`),
    reason: text("reason"),
    createdBy: uuid("created_by").references(() => user.id),
    createdAt: tz("created_at").notNull(),
    settledAt: tz("settled_at"),
  },
  (t) => [
    unique("mailbox_header_checks_workspace_id_id_key").on(t.workspaceId, t.id),
    index("mailbox_header_checks_current_idx").on(t.workspaceId, t.credentialId, t.seq),
    foreignKey({ name: "mailbox_header_checks_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "mailbox_header_checks_credential_fk", columns: [t.workspaceId, t.credentialId], foreignColumns: [credentials.workspaceId, credentials.id] }),
    foreignKey({ name: "mailbox_header_checks_action_fk", columns: [t.workspaceId, t.probeActionId], foreignColumns: [actions.workspaceId, actions.id] }),
    check("mailbox_header_checks_state_check", sql`${t.state} in ('unchecked', 'pending', 'passed', 'replies_only', 'failed', 'inconclusive')`),
  ],
);

/**
 * Touches Direx learned of but didn't send: a call, a hand-sent message, email from another tool.
 * An outbound one holds Direx's next Touch to the gap without counting toward the 30-day limit;
 * an inbound one is a reply. Rows are never edited.
 */
export const outsideTouches = pgTable(
  "outside_touches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    personId: uuid("person_id").notNull(),
    channel: text("channel").notNull(),
    direction: text("direction").notNull(),
    occurredAt: tz("occurred_at").notNull(),
    source: text("source").notNull(),
    // The DM draft Item for direx_draft; a CRM activity id later. A retry with the same ref adds nothing.
    sourceRef: text("source_ref"),
    createdBy: uuid("created_by").notNull().references(() => user.id),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    unique("outside_touches_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("outside_touches_source_ref_key").on(t.workspaceId, t.source, t.sourceRef),
    index("outside_touches_person_idx").on(t.workspaceId, t.personId, t.occurredAt),
    foreignKey({ name: "outside_touches_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "outside_touches_person_fk", columns: [t.workspaceId, t.personId], foreignColumns: [people.workspaceId, people.id] }),
    check("outside_touches_channel_check", sql`${t.channel} in ('call', 'linkedin', 'x', 'email_other', 'other')`),
    check("outside_touches_direction_check", sql`${t.direction} in ('outbound', 'inbound')`),
    check("outside_touches_source_check", sql`${t.source} in ('manual', 'direx_draft')`),
    check("outside_touches_source_ref_check", sql`(${t.source} = 'manual') = (${t.sourceRef} is null)`),
  ],
);

/**
 * A Person the workspace is already talking to, by a source that knows it: a person saying so, or
 * another CRM through the add-only webhook. Keyed by a keyed hash of the address, so a hold can wait
 * for an address that isn't imported yet. Rows are ended, never removed.
 */
export const relationshipHolds = pgTable(
  "relationship_holds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    emailHash: text("email_hash").notNull(),
    // The address's company domain; null for a shared mail provider, so it holds no colleagues.
    domain: text("domain"),
    personId: uuid("person_id"),
    source: text("source").notNull(),
    // The webhook's id for a webhook hold, so sending it again extends the same row.
    sourceRef: text("source_ref"),
    reason: text("reason").notNull(),
    startedAt: tz("started_at").notNull(),
    expiresAt: tz("expires_at").notNull(),
    endedAt: tz("ended_at"),
    endedBy: uuid("ended_by").references(() => user.id),
    createdBy: uuid("created_by").references(() => user.id),
  },
  (t) => [
    unique("relationship_holds_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("relationship_holds_source_ref_key").on(t.workspaceId, t.source, t.sourceRef, t.emailHash),
    index("relationship_holds_email_idx").on(t.workspaceId, t.emailHash),
    index("relationship_holds_domain_idx").on(t.workspaceId, t.domain),
    foreignKey({ name: "relationship_holds_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "relationship_holds_person_fk", columns: [t.workspaceId, t.personId], foreignColumns: [people.workspaceId, people.id] }),
    check("relationship_holds_source_check", sql`${t.source} in ('manual', 'webhook')`),
    check("relationship_holds_source_ref_check", sql`(${t.source} = 'manual') = (${t.sourceRef} is null)`),
    check("relationship_holds_term_check", sql`${t.expiresAt} > ${t.startedAt}`),
  ],
);

/** The newest hand-written email to each address, by hash only: no address, subject or body. */
export const correspondents = pgTable(
  "correspondents",
  {
    workspaceId: uuid("workspace_id").notNull(),
    emailHash: text("email_hash").notNull(),
    source: text("source").notNull(),
    credentialId: uuid("credential_id").notNull(),
    lastSeenAt: tz("last_seen_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "correspondents_pkey", columns: [t.workspaceId, t.emailHash, t.source] }),
    foreignKey({ name: "correspondents_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "correspondents_credential_fk", columns: [t.workspaceId, t.credentialId], foreignColumns: [credentials.workspaceId, credentials.id] }),
    check("correspondents_source_check", sql`${t.source} in ('sent_mail')`),
  ],
);

/** Each time a person released a guessed hold. Only the newest counts; rows are never edited. */
export const holdReleases = pgTable(
  "hold_releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    personId: uuid("person_id").notNull(),
    kind: text("kind").notNull(),
    releasedAt: tz("released_at").notNull(),
    releasedBy: uuid("released_by").notNull().references(() => user.id),
  },
  (t) => [
    unique("hold_releases_workspace_id_id_key").on(t.workspaceId, t.id),
    index("hold_releases_person_idx").on(t.workspaceId, t.personId, t.kind, t.releasedAt),
    foreignKey({ name: "hold_releases_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "hold_releases_person_fk", columns: [t.workspaceId, t.personId], foreignColumns: [people.workspaceId, people.id] }),
    check("hold_releases_kind_check", sql`${t.kind} in ('inferred', 'company')`),
  ],
);

/** An add-only webhook another CRM calls; its secret is a workspace credential. */
export const holdHooks = pgTable(
  "hold_hooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    credentialId: uuid("credential_id").notNull(),
    createdAt: tz("created_at").notNull(),
    createdBy: uuid("created_by").notNull().references(() => user.id),
    disabledAt: tz("disabled_at"),
  },
  (t) => [
    unique("hold_hooks_workspace_id_id_key").on(t.workspaceId, t.id),
    foreignKey({ name: "hold_hooks_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "hold_hooks_credential_fk", columns: [t.workspaceId, t.credentialId], foreignColumns: [credentials.workspaceId, credentials.id] }),
  ],
);
