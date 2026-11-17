// SPDX-License-Identifier: AGPL-3.0-only
// Placement checks: a person's yes or no for one Mailbox, and who stopped it. Each answer is a new
// row and the newest one for a Mailbox is the one that counts; a row is never removed, and only its
// stop can be written after it is made. Also a person's yes to one Campaign step's content test.
import { sql } from "drizzle-orm";
import { bigint, check, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { actions, bytea, credentials, workspaces } from "./schema";
import { campaignSteps } from "./schema-campaigns";

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const placementGrants = pgTable(
  "placement_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Orders answers by when they were made, even two made in the same instant.
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    workspaceId: uuid("workspace_id").notNull(),
    credentialId: uuid("credential_id").notNull(),
    answer: text("answer").notNull(),
    // The version of the words shown right before the answer.
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
    unique("placement_grants_workspace_id_id_key").on(t.workspaceId, t.id),
    index("placement_grants_current_idx").on(t.workspaceId, t.credentialId, t.seq),
    foreignKey({ name: "placement_grants_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "placement_grants_credential_fk", columns: [t.workspaceId, t.credentialId], foreignColumns: [credentials.workspaceId, credentials.id] }),
    check("placement_grants_answer_check", sql`${t.answer} in ('yes', 'no')`),
    // A stop names when and why, and only a yes can be stopped. It names who unless Direx stopped it,
    // as when the provider refused a check as over its sending limit.
    check("placement_grants_stop_check", sql`(${t.stoppedAt} is null and ${t.stoppedBy} is null and ${t.stopReason} is null) or (${t.answer} = 'yes' and ${t.stoppedAt} is not null and length(${t.stopReason}) between 1 and 500)`),
  ],
);

// A person's yes to sending one template step, filled with placeholder values, as Placement checks to
// the receiving addresses they were shown. The newest yes for a step is the one that counts; none is
// changed or removed.
export const placementContentTests = pgTable(
  "placement_content_tests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    workspaceId: uuid("workspace_id").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    stepKey: text("step_key").notNull(),
    // The receiving addresses shown right before the yes, lower case.
    receivers: text("receivers").array().notNull(),
    wordingVersion: text("wording_version").notNull(),
    saidBy: uuid("said_by")
      .notNull()
      .references(() => user.id),
    saidAt: tz("said_at").notNull(),
  },
  (t) => [
    unique("placement_content_tests_workspace_id_id_key").on(t.workspaceId, t.id),
    index("placement_content_tests_current_idx").on(t.workspaceId, t.campaignId, t.stepKey, t.seq),
    foreignKey({ name: "placement_content_tests_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "placement_content_tests_step_fk", columns: [t.workspaceId, t.campaignId, t.stepKey], foreignColumns: [campaignSteps.workspaceId, campaignSteps.campaignId, campaignSteps.stepKey] }),
    check("placement_content_tests_receivers_check", sql`cardinality(${t.receivers}) between 1 and 50`),
  ],
);

// Each placement Mailbox's own signing key: the private half sealed in the vault the way approval
// keys are, the public half in the clear because it goes in the Placement circle's member list.
// Made on first need and never changed or removed.
export const placementMemberKeys = pgTable(
  "placement_member_keys",
  {
    workspaceId: uuid("workspace_id").notNull(),
    credentialId: uuid("credential_id").notNull(),
    publicKey: text("public_key").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    nonce: bytea("nonce").notNull(),
    keyVersion: integer("key_version").notNull(),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "placement_member_keys_pkey", columns: [t.workspaceId, t.credentialId] }),
    foreignKey({ name: "placement_member_keys_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "placement_member_keys_credential_fk", columns: [t.workspaceId, t.credentialId], foreignColumns: [credentials.workspaceId, credentials.id] }),
  ],
);

// The member list this Workspace last trusted: its version, content hash and the list itself, so a
// later list is never older, never a different list at the same version, and a removal signed by one
// signer can be checked against it. Also how many root changes it chained through and their hash, so a
// later list can't go back to an older root or a different chain. Moves forward only.
export const placementListState = pgTable(
  "placement_list_state",
  {
    workspaceId: uuid("workspace_id").primaryKey(),
    version: integer("version").notNull(),
    contentHash: text("content_hash").notNull(),
    list: jsonb("list").notNull(),
    rootChainLength: integer("root_chain_length").notNull(),
    rootChainHash: text("root_chain_hash").notNull(),
    // The root this release pinned when the list was trusted. A release that pins another root
    // (a lost or stolen signer key) starts trust over. Empty on rows written before it was kept.
    pinnedRootHash: text("pinned_root_hash").notNull().default(""),
    trustedAt: tz("trusted_at").notNull(),
  },
  (t) => [foreignKey({ name: "placement_list_state_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }), check("placement_list_state_version_check", sql`${t.version} >= 1`), check("placement_list_state_root_chain_length_check", sql`${t.rootChainLength} >= 0`)],
);

// Each Placement check one of this Workspace's Mailboxes sends or expects, one row per day, other
// member and kind. A sent check names its Action; one skipped or cancelled names why, so a report
// can tell a check its sender never sent from one that went missing. The receiving side's verdict,
// the report about it, and the archiving of a content check are written later on the same row.
export const placementProbes = pgTable(
  "placement_probes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    // This Workspace's Mailbox: the sender of a sent check, the receiver of an expected one.
    credentialId: uuid("credential_id").notNull(),
    direction: text("direction").notNull(),
    // The UTC day of the seed the check belongs to.
    day: date("day", { mode: "string" }).notNull(),
    listVersion: integer("list_version").notNull(),
    kind: text("kind").notNull(),
    seq: integer("seq").notNull(),
    // The other Circle member's address.
    peer: text("peer").notNull(),
    expectedAt: tz("expected_at").notNull(),
    actionId: uuid("action_id"),
    // The Message-ID the receiver saw. A sent check's is its Action's correlation key.
    messageId: text("message_id"),
    skipReason: text("skip_reason"),
    // An expected check's subject text as the receiver searches for it: a plain check's library
    // subject, or a content check's tag. Derived from the list and the day, never read from the mail.
    subject: text("subject"),
    verdict: text("verdict"),
    readAt: tz("read_at"),
    reportedVerdict: text("reported_verdict"),
    reportedAt: tz("reported_at"),
    archiveActionId: uuid("archive_action_id"),
    // On an expected check: the placement.report Action that reported its verdict to its sender.
    reportActionId: uuid("report_action_id"),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    // A rerun of the day's job finds the row it made and makes nothing twice.
    unique("placement_probes_once_key").on(t.workspaceId, t.credentialId, t.direction, t.day, t.peer, t.kind),
    index("placement_probes_action_idx").on(t.workspaceId, t.actionId),
    index("placement_probes_report_action_idx").on(t.workspaceId, t.reportActionId),
    // A report counts a sent check once: its Message-ID is written when the first report is counted.
    uniqueIndex("placement_probes_sent_message_key").on(t.workspaceId, t.messageId).where(sql`${t.direction} = 'send'`),
    foreignKey({ name: "placement_probes_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "placement_probes_credential_fk", columns: [t.workspaceId, t.credentialId], foreignColumns: [credentials.workspaceId, credentials.id] }),
    foreignKey({ name: "placement_probes_action_fk", columns: [t.workspaceId, t.actionId], foreignColumns: [actions.workspaceId, actions.id] }),
    foreignKey({ name: "placement_probes_archive_action_fk", columns: [t.workspaceId, t.archiveActionId], foreignColumns: [actions.workspaceId, actions.id] }),
    foreignKey({ name: "placement_probes_report_action_fk", columns: [t.workspaceId, t.reportActionId], foreignColumns: [actions.workspaceId, actions.id] }),
    check("placement_probes_direction_check", sql`${t.direction} in ('send', 'receive')`),
    check("placement_probes_kind_check", sql`${t.kind} in ('plain', 'content')`),
    check("placement_probes_verdict_check", sql`${t.verdict} in ('primary', 'other_tab', 'spam', 'missing', 'query_failure')`),
    check("placement_probes_reported_verdict_check", sql`${t.reportedVerdict} in ('primary', 'other_tab', 'spam', 'missing', 'query_failure')`),
  ],
);
