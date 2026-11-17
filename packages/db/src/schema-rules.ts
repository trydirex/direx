// SPDX-License-Identifier: AGPL-3.0-only
// Standing rules: a person's bounded, expiring permission to approve one template step's emails.
// Expiry is read from expires_at, so "expired" is never a stored status. Rules are never deleted.
import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { actions, workspaces } from "./schema";
import { campaignSteps } from "./schema-campaigns";

const tz = (name: string) => timestamp(name, { withTimezone: true });

export type RuleFact = { id: string; version: string };

export const standingRules = pgTable(
  "standing_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    capability: text("capability").notNull(),
    touchClass: text("touch_class").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    stepKey: text("step_key").notNull(),
    // A template rule covers words a person read; an agent-written rule covers what one drafter writes.
    mode: text("mode").notNull().default("template"),
    // Null for an agent-written rule.
    templateRevision: integer("template_revision"),
    facts: jsonb("facts").$type<RuleFact[]>().notNull(),
    capabilityHash: text("capability_hash").notNull(),
    // Null for an agent-written rule, which has no daily cap.
    dailyCap: integer("daily_cap"),
    // Agent-written only: the drafter it was granted on, the Fact versions it may use, the campaign's
    // answer on outside content, the language and the form wording the granter agreed to.
    producer: jsonb("producer"),
    allowedFacts: jsonb("allowed_facts").$type<RuleFact[]>(),
    outsideContent: boolean("outside_content"),
    language: text("language"),
    wordingVersion: text("wording_version"),
    expiresAt: tz("expires_at").notNull(),
    grantedBy: uuid("granted_by")
      .notNull()
      .references(() => user.id),
    grantedAt: tz("granted_at").notNull(),
    peopleAsOf: tz("people_as_of").notNull(),
    // Null when a person wrote the template.
    draftingAgent: text("drafting_agent"),
    status: text("status").notNull().default("active"),
    suspendedReason: text("suspended_reason"),
    revision: integer("revision").notNull().default(1),
  },
  (t) => [
    unique("standing_rules_workspace_id_id_key").on(t.workspaceId, t.id),
    foreignKey({ name: "standing_rules_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "standing_rules_step_fk", columns: [t.workspaceId, t.campaignId, t.stepKey], foreignColumns: [campaignSteps.workspaceId, campaignSteps.campaignId, campaignSteps.stepKey] }),
    index("standing_rules_step_idx").on(t.workspaceId, t.campaignId, t.stepKey),
    check("standing_rules_status_check", sql`${t.status} in ('active', 'suspended', 'revoked')`),
    check("standing_rules_suspended_reason_check", sql`(${t.status} = 'suspended') = (${t.suspendedReason} is not null)`),
    check("standing_rules_daily_cap_check", sql`${t.dailyCap} > 0`),
    check("standing_rules_touch_class_check", sql`${t.touchClass} in ('cold', 'consented_marketing')`),
    check("standing_rules_mode_check", sql`${t.mode} in ('template', 'agent_written')`),
    check(
      "standing_rules_template_mode_check",
      sql`${t.mode} <> 'template' or (${t.templateRevision} is not null and ${t.dailyCap} is not null and ${t.producer} is null)`,
    ),
    check(
      "standing_rules_agent_mode_check",
      sql`${t.mode} <> 'agent_written' or (${t.templateRevision} is null and ${t.dailyCap} is null and ${t.producer} is not null and ${t.allowedFacts} is not null and ${t.outsideContent} = true and ${t.language} is not null and ${t.wordingVersion} is not null and ${t.draftingAgent} is not null)`,
    ),
  ],
);

// Append-only: one row per grant, re-confirm, suspend or revoke.
export const standingRuleRevisions = pgTable(
  "standing_rule_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    ruleId: uuid("rule_id").notNull(),
    revision: integer("revision").notNull(),
    change: text("change").notNull(),
    reason: text("reason"),
    facts: jsonb("facts").$type<RuleFact[]>().notNull(),
    capabilityHash: text("capability_hash").notNull(),
    templateRevision: integer("template_revision"),
    producer: jsonb("producer"),
    actorUserId: uuid("actor_user_id"),
    actorSystem: text("actor_system"),
    at: tz("at").notNull(),
  },
  (t) => [
    foreignKey({ name: "standing_rule_revisions_rule_fk", columns: [t.workspaceId, t.ruleId], foreignColumns: [standingRules.workspaceId, standingRules.id] }),
    index("standing_rule_revisions_rule_idx").on(t.workspaceId, t.ruleId),
    check("standing_rule_revisions_change_check", sql`${t.change} in ('grant', 'reconfirm', 'suspend', 'revoke')`),
    check("standing_rule_revisions_one_actor_check", sql`num_nonnulls(${t.actorUserId}, ${t.actorSystem}) = 1`),
  ],
);

// One row per Action a rule counted against its cap. A full Touch slot gives the count back, so
// rows may be deleted but never changed.
export const standingRuleUses = pgTable(
  "standing_rule_uses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    ruleId: uuid("rule_id").notNull(),
    actionId: uuid("action_id").notNull(),
    // The UTC day of the send time.
    day: date("day").notNull(),
    at: tz("at").notNull(),
  },
  (t) => [
    unique("standing_rule_uses_rule_action_key").on(t.ruleId, t.actionId),
    foreignKey({ name: "standing_rule_uses_rule_fk", columns: [t.workspaceId, t.ruleId], foreignColumns: [standingRules.workspaceId, standingRules.id] }),
    foreignKey({ name: "standing_rule_uses_action_fk", columns: [t.workspaceId, t.actionId], foreignColumns: [actions.workspaceId, actions.id] }),
    index("standing_rule_uses_day_idx").on(t.workspaceId, t.ruleId, t.day),
  ],
);
