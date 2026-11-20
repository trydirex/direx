// SPDX-License-Identifier: AGPL-3.0-only
// One campaign per marketing plan: who it goes to and how each step is written. Rows here point at
// Actions, so the ledger and items know nothing about campaigns. Nothing is deleted.
import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { actions, credentials, items, people, workspaces } from "./schema";
import { marketingPlans } from "./schema-plans";

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    planId: uuid("plan_id").notNull(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => user.id),
    // Null until a person answers: nothing is written before they choose.
    draftingMode: text("drafting_mode"),
    pausedAt: tz("paused_at"),
    pausedBy: uuid("paused_by").references(() => user.id),
    // Whether drafts shaped by a recipient's website or list values may go out under an agent-written rule.
    outsideContentAllowed: boolean("outside_content_allowed").notNull().default(false),
    outsideContentSetBy: uuid("outside_content_set_by").references(() => user.id),
    outsideContentSetAt: tz("outside_content_set_at"),
    // Under 'run', Next steps start as soon as they are made, as the person who chose it, timed in their zone.
    advance: text("advance").notNull().default("offer"),
    advanceSetBy: uuid("advance_set_by").references(() => user.id),
    advanceSetAt: tz("advance_set_at"),
    advanceTimeZone: text("advance_time_zone"),
    // The launch every step keeps its distance from. Null until moved: the plan's start date.
    anchorOn: date("anchor_on", { mode: "string" }),
    // A manual or post step whose output is the launch, when the launch follows a step instead of a date.
    anchorStepKey: text("anchor_step_key"),
    anchorMovedBy: uuid("anchor_moved_by").references(() => user.id),
    anchorMovedAt: tz("anchor_moved_at"),
    // A person's notes on the Campaign: context, feedback, meeting notes. Plain text; a Draft may hold them
    // (ADR 0023, revised 2026-11-14). Saved only over the revision the person read.
    notes: text("notes").notNull().default(""),
    notesRevision: integer("notes_revision").notNull().default(0),
    notesUpdatedBy: uuid("notes_updated_by").references(() => user.id),
    notesUpdatedAt: tz("notes_updated_at"),
    // Tracked links (ADR 0035 rules 001, 012, 016): off until a person turns them on and confirms the
    // notice; the per-Person switch only while tracking is on. The domain's foreign key is in migration
    // 0158, since schema-tracking imports this file.
    trackingDomainId: uuid("tracking_domain_id"),
    trackingOn: boolean("tracking_on").notNull().default(false),
    trackingSetBy: uuid("tracking_set_by").references(() => user.id),
    trackingSetAt: tz("tracking_set_at"),
    trackingWordingVersion: integer("tracking_wording_version"),
    perPersonOn: boolean("per_person_on").notNull().default(false),
    perPersonSetBy: uuid("per_person_set_by").references(() => user.id),
    perPersonSetAt: tz("per_person_set_at"),
    perPersonWordingVersion: integer("per_person_wording_version"),
    createdAt: tz("created_at").notNull(),
    updatedAt: tz("updated_at").notNull(),
  },
  (t) => [
    unique("campaigns_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("campaigns_one_per_plan").on(t.workspaceId, t.planId),
    check("campaigns_tracking_check", sql`not ${t.trackingOn} or (${t.trackingDomainId} is not null and ${t.trackingSetBy} is not null and ${t.trackingWordingVersion} is not null)`),
    check("campaigns_per_person_check", sql`not ${t.perPersonOn} or (${t.trackingOn} and ${t.perPersonSetBy} is not null and ${t.perPersonWordingVersion} is not null)`),
    foreignKey({ name: "campaigns_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "campaigns_plan_fk", columns: [t.workspaceId, t.planId], foreignColumns: [marketingPlans.workspaceId, marketingPlans.id] }),
    check("campaigns_drafting_mode_check", sql`${t.draftingMode} in ('template', 'per_person')`),
    // A run grant names who gave it and the zone drafts are timed in.
    check("campaigns_anchor_moved_check", sql`(${t.anchorMovedBy} is null) = (${t.anchorMovedAt} is null)`),
    check("campaigns_advance_check", sql`${t.advance} = 'offer' or (${t.advance} = 'run' and ${t.advanceSetBy} is not null and ${t.advanceTimeZone} is not null)`),
    check("campaigns_notes_length_check", sql`char_length(${t.notes}) <= 10000`),
    check("campaigns_notes_updated_check", sql`(${t.notesUpdatedBy} is null) = (${t.notesUpdatedAt} is null)`),
  ],
);

// A row exists once a person sets a step up. Steps in the plan with no row are still manual.
export const campaignSteps = pgTable(
  "campaign_steps",
  {
    workspaceId: uuid("workspace_id").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    stepKey: text("step_key").notNull(),
    type: text("type").notNull(),
    // Null for a post step: a post is not a Touch.
    touchClass: text("touch_class").default("cold"),
    mailboxCredentialId: uuid("mailbox_credential_id"),
    audience: text("audience").notNull().default("everyone"),
    // Where a DM step's messages go. A person sends each one by hand.
    dmChannel: text("dm_channel"),
    template: jsonb("template"),
    templateRevision: integer("template_revision").notNull().default(0),
    draftRunId: uuid("draft_run_id"),
    // How an email step is written: one template, or a draft per Person. Fixed once the step has a draft.
    draftingMode: text("drafting_mode"),
    // Set when a person chose to go ahead without the output this step waits on.
    dependencyWaivedAt: tz("dependency_waived_at"),
    dependencyWaivedBy: uuid("dependency_waived_by").references(() => user.id),
    // Set when a person cancelled the step, as a stalled step's choice. Its unsent Actions are cancelled too.
    cancelledAt: tz("cancelled_at"),
    cancelledBy: uuid("cancelled_by").references(() => user.id),
    // For a step others wait on: when a person last chose to keep waiting for its output.
    stallWaitFrom: tz("stall_wait_from"),
    // The step whose output, a URL, this step waits on. One level deep.
    dependsOnStepKey: text("depends_on_step_key"),
    // For a post step others wait on: the account whose post URL is the output, named as social_posts names it.
    outputConnection: text("output_connection"),
    outputNetworkId: text("output_network_id"),
    // Whether a URL filled in from another step's output carries Direx's UTM tags.
    utm: boolean("utm").notNull().default(false),
    // An SEO brief step's page and search, and the brief run it last started.
    seoSetup: jsonb("seo_setup"),
    briefRunId: uuid("brief_run_id"),
    // A person's notes for a per-Person step's writer, usually from an edit they kept making.
    writerNotes: text("writer_notes"),
    writerNotesRevision: integer("writer_notes_revision").notNull().default(0),
    updatedAt: tz("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "campaign_steps_pkey", columns: [t.workspaceId, t.campaignId, t.stepKey] }),
    foreignKey({ name: "campaign_steps_campaign_fk", columns: [t.workspaceId, t.campaignId], foreignColumns: [campaigns.workspaceId, campaigns.id] }),
    foreignKey({ name: "campaign_steps_depends_on_fk", columns: [t.workspaceId, t.campaignId, t.dependsOnStepKey], foreignColumns: [t.workspaceId, t.campaignId, t.stepKey] }),
    check("campaign_steps_depends_on_self_check", sql`${t.dependsOnStepKey} is distinct from ${t.stepKey}`),
    check("campaign_steps_output_account_check", sql`(${t.outputConnection} is null) = (${t.outputNetworkId} is null) and (${t.outputConnection} is null or ${t.type} = 'post')`),
    foreignKey({ name: "campaign_steps_mailbox_fk", columns: [t.workspaceId, t.mailboxCredentialId], foreignColumns: [credentials.workspaceId, credentials.id] }),
    check("campaign_steps_type_check", sql`${t.type} in ('email', 'manual', 'post', 'dm', 'clips', 'seo_brief')`),
    check("campaign_steps_seo_setup_check", sql`(${t.seoSetup} is null and ${t.briefRunId} is null) or ${t.type} = 'seo_brief'`),
    check("campaign_steps_dm_channel_check", sql`(${t.type} = 'dm') = (${t.dmChannel} is not null) and (${t.dmChannel} is null or ${t.dmChannel} in ('linkedin', 'x'))`),
    check("campaign_steps_touch_class_post_check", sql`(${t.type} in ('post', 'clips', 'seo_brief')) = (${t.touchClass} is null)`),
    check("campaign_steps_touch_class_check", sql`${t.touchClass} in ('cold', 'consented_marketing')`),
    check("campaign_steps_waived_check", sql`(${t.dependencyWaivedAt} is null) = (${t.dependencyWaivedBy} is null)`),
    check("campaign_steps_cancelled_check", sql`(${t.cancelledAt} is null) = (${t.cancelledBy} is null)`),
    check("campaign_steps_drafting_mode_check", sql`${t.draftingMode} in ('template', 'per_person')`),
    check("campaign_steps_audience_check", sql`${t.audience} in ('everyone', 'no_reply_yet')`),
  ],
);

// The Mailboxes an email step's emails are shared across. Each email keeps the Mailbox it was written
// with; taking one off the step leaves its drafts on it. Replaces campaign_steps.mailbox_credential_id.
export const campaignStepMailboxes = pgTable(
  "campaign_step_mailboxes",
  {
    workspaceId: uuid("workspace_id").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    stepKey: text("step_key").notNull(),
    credentialId: uuid("credential_id").notNull(),
    addedAt: tz("added_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "campaign_step_mailboxes_pkey", columns: [t.workspaceId, t.campaignId, t.stepKey, t.credentialId] }),
    foreignKey({ name: "campaign_step_mailboxes_step_fk", columns: [t.workspaceId, t.campaignId, t.stepKey], foreignColumns: [campaignSteps.workspaceId, campaignSteps.campaignId, campaignSteps.stepKey] }),
    foreignKey({ name: "campaign_step_mailboxes_credential_fk", columns: [t.workspaceId, t.credentialId], foreignColumns: [credentials.workspaceId, credentials.id] }),
  ],
);

// A clips step's recordings, one row per press of "Make clips": the recording, the accounts and the
// first post time, and the clip run making its clips. Kept when the step changes type; never deleted.
export const clipStepRuns = pgTable(
  "clip_step_runs",
  {
    workspaceId: uuid("workspace_id").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    stepKey: text("step_key").notNull(),
    runId: uuid("run_id").notNull(),
    setup: jsonb("setup").notNull(),
    startedBy: uuid("started_by")
      .notNull()
      .references(() => user.id),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "clip_step_runs_pkey", columns: [t.workspaceId, t.runId] }),
    foreignKey({ name: "clip_step_runs_step_fk", columns: [t.workspaceId, t.campaignId, t.stepKey], foreignColumns: [campaignSteps.workspaceId, campaignSteps.campaignId, campaignSteps.stepKey] }),
    index("clip_step_runs_step_idx").on(t.workspaceId, t.campaignId, t.stepKey, t.createdAt),
  ],
);

// A plan version that held a step: what it changed, the plan's new text when it suggested some, and
// the person's choice. An undecided row holds the step's Actions at claim. A later version replaces
// the row; rows are never deleted.
export const campaignPlanChanges = pgTable(
  "campaign_plan_changes",
  {
    workspaceId: uuid("workspace_id").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    stepKey: text("step_key").notNull(),
    // The plan version the step last settled on, and the approved one that changed it.
    fromVersion: integer("from_version").notNull(),
    toVersion: integer("to_version").notNull(),
    kinds: text("kinds").array().notNull(),
    suggestedTemplate: jsonb("suggested_template"),
    itemId: uuid("item_id").notNull(),
    decided: text("decided"),
    decidedBy: uuid("decided_by").references(() => user.id),
    decidedAt: tz("decided_at"),
  },
  (t) => [
    primaryKey({ name: "campaign_plan_changes_pkey", columns: [t.workspaceId, t.campaignId, t.stepKey] }),
    foreignKey({ name: "campaign_plan_changes_campaign_fk", columns: [t.workspaceId, t.campaignId], foreignColumns: [campaigns.workspaceId, campaigns.id] }),
    foreignKey({ name: "campaign_plan_changes_item_fk", columns: [t.workspaceId, t.itemId], foreignColumns: [items.workspaceId, items.id] }),
    check("campaign_plan_changes_kinds_check", sql`cardinality(${t.kinds}) > 0 and ${t.kinds} <@ array['text', 'channel', 'removed']`),
    check("campaign_plan_changes_suggested_check", sql`(${t.suggestedTemplate} is not null) = ('text' = any(${t.kinds}))`),
    check(
      "campaign_plan_changes_decided_check",
      sql`num_nulls(${t.decided}, ${t.decidedBy}, ${t.decidedAt}) in (0, 3) and ${t.decided} in ('keep', 'use_new_text', 'cancel')`,
    ),
  ],
);

// Plan change work still owed after its approval committed: Items to move to recorded dates, text to
// fill or use, held Items to resume. Written in the approval's transaction, worked through after it,
// and retried by a sweep until done. Rows are kept, with when they were settled.
export const campaignSettlements = pgTable(
  "campaign_settlements",
  {
    workspaceId: uuid("workspace_id").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    // "plan:<version>" for an approved plan version, "choice:<item id>" for a person's choice on a held step.
    key: text("key").notNull(),
    work: jsonb("work").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    // A run holds the row until then, so the sweep and the run after the commit don't both work it.
    claimedUntil: tz("claimed_until"),
    createdAt: tz("created_at").notNull(),
    settledAt: tz("settled_at"),
  },
  (t) => [
    primaryKey({ name: "campaign_settlements_pkey", columns: [t.workspaceId, t.campaignId, t.key] }),
    foreignKey({ name: "campaign_settlements_campaign_fk", columns: [t.workspaceId, t.campaignId], foreignColumns: [campaigns.workspaceId, campaigns.id] }),
    check("campaign_settlements_attempts_check", sql`${t.attempts} >= 0`),
  ],
);

export const campaignPeople = pgTable(
  "campaign_people",
  {
    workspaceId: uuid("workspace_id").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    personId: uuid("person_id").notNull(),
    status: text("status").notNull().default("active"),
    firstName: text("first_name"),
    company: text("company"),
    website: text("website"),
    // Set when a person chose to add them once another campaign has finished with them.
    afterCampaignId: uuid("after_campaign_id"),
    conflictItemId: uuid("conflict_item_id"),
    addedBy: uuid("added_by")
      .notNull()
      .references(() => user.id),
    at: tz("at").notNull(),
  },
  (t) => [
    primaryKey({ name: "campaign_people_pkey", columns: [t.workspaceId, t.campaignId, t.personId] }),
    foreignKey({ name: "campaign_people_campaign_fk", columns: [t.workspaceId, t.campaignId], foreignColumns: [campaigns.workspaceId, campaigns.id] }),
    foreignKey({ name: "campaign_people_after_fk", columns: [t.workspaceId, t.afterCampaignId], foreignColumns: [campaigns.workspaceId, campaigns.id] }),
    foreignKey({ name: "campaign_people_conflict_item_fk", columns: [t.workspaceId, t.conflictItemId], foreignColumns: [items.workspaceId, items.id] }),
    foreignKey({ name: "campaign_people_person_fk", columns: [t.workspaceId, t.personId], foreignColumns: [people.workspaceId, people.id] }),
    index("campaign_people_person_idx").on(t.workspaceId, t.personId),
    check("campaign_people_status_check", sql`${t.status} in ('active', 'replied', 'removed', 'conflict')`),
  ],
);

export const campaignActions = pgTable(
  "campaign_actions",
  {
    workspaceId: uuid("workspace_id").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    stepKey: text("step_key").notNull(),
    personId: uuid("person_id").notNull(),
    actionId: uuid("action_id").notNull(),
    /** What wrote a per-person draft: reader, writer and the Fact versions shown. Kept out of the approval snapshot. */
    producer: jsonb("producer"),
    /** What the draft checks found, bound to the exact words they read. Kept out of the approval snapshot. */
    checks: jsonb("checks"),
    /** The writer's words as it proposed them, so a person's edits can be measured against them. */
    proposedText: text("proposed_text"),
  },
  (t) => [
    primaryKey({ name: "campaign_actions_pkey", columns: [t.workspaceId, t.campaignId, t.stepKey, t.personId] }),
    foreignKey({ name: "campaign_actions_person_fk", columns: [t.workspaceId, t.campaignId, t.personId], foreignColumns: [campaignPeople.workspaceId, campaignPeople.campaignId, campaignPeople.personId] }),
    foreignKey({ name: "campaign_actions_action_fk", columns: [t.workspaceId, t.actionId], foreignColumns: [actions.workspaceId, actions.id] }),
    index("campaign_actions_action_idx").on(t.workspaceId, t.actionId),
  ],
);

/**
 * One DM a DM step drafted for one Person, which a person sends by hand on LinkedIn or X. Direx
 * sends nothing, so these are not Actions and never wait for approval. Marking one sent logs an
 * outside touch.
 */
export const campaignDms = pgTable(
  "campaign_dms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    stepKey: text("step_key").notNull(),
    personId: uuid("person_id").notNull(),
    channel: text("channel").notNull(),
    profileUrl: text("profile_url").notNull(),
    text: text("text").notNull(),
    templateRevision: integer("template_revision").notNull(),
    createdAt: tz("created_at").notNull(),
    copiedAt: tz("copied_at"),
    sentAt: tz("sent_at"),
    sentBy: uuid("sent_by").references(() => user.id),
  },
  (t) => [
    unique("campaign_dms_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("campaign_dms_person_key").on(t.workspaceId, t.campaignId, t.stepKey, t.personId),
    foreignKey({ name: "campaign_dms_person_fk", columns: [t.workspaceId, t.campaignId, t.personId], foreignColumns: [campaignPeople.workspaceId, campaignPeople.campaignId, campaignPeople.personId] }),
    foreignKey({ name: "campaign_dms_step_fk", columns: [t.workspaceId, t.campaignId, t.stepKey], foreignColumns: [campaignSteps.workspaceId, campaignSteps.campaignId, campaignSteps.stepKey] }),
    check("campaign_dms_channel_check", sql`${t.channel} in ('linkedin', 'x')`),
    check("campaign_dms_sent_check", sql`(${t.sentAt} is null) = (${t.sentBy} is null)`),
  ],
);

// A step's output, a URL, kept as versions. The latest is current; earlier ones stay, because an
// approval may rest on one of them. Rows are never changed or deleted.
export const campaignStepOutputs = pgTable(
  "campaign_step_outputs",
  {
    workspaceId: uuid("workspace_id").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    stepKey: text("step_key").notNull(),
    version: integer("version").notNull(),
    url: text("url").notNull(),
    source: text("source").notNull(),
    actorUserId: uuid("actor_user_id").references(() => user.id),
    actorSystem: text("actor_system"),
    at: tz("at").notNull(),
  },
  (t) => [
    primaryKey({ name: "campaign_step_outputs_pkey", columns: [t.workspaceId, t.campaignId, t.stepKey, t.version] }),
    foreignKey({ name: "campaign_step_outputs_step_fk", columns: [t.workspaceId, t.campaignId, t.stepKey], foreignColumns: [campaignSteps.workspaceId, campaignSteps.campaignId, campaignSteps.stepKey] }),
    check("campaign_step_outputs_version_check", sql`${t.version} >= 1`),
    check("campaign_step_outputs_url_check", sql`${t.url} like 'https://%' and length(${t.url}) <= 2048`),
    check("campaign_step_outputs_source_check", sql`${t.source} in ('person', 'system')`),
    check("campaign_step_outputs_one_actor_check", sql`num_nonnulls(${t.actorUserId}, ${t.actorSystem}) = 1`),
    check("campaign_step_outputs_source_matches_actor_check", sql`(${t.source} = 'person') = (${t.actorUserId} is not null)`),
  ],
);

// A person's mark that a Campaign Person booked a meeting or opened a deal, on the day they say, or
// an undo row naming the mark it voids. A mark is live while no row voids it. Rows are never changed
// or deleted.
export const campaignOutcomes = pgTable(
  "campaign_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    personId: uuid("person_id").notNull(),
    kind: text("kind").notNull(),
    occurredOn: date("occurred_on"),
    voids: uuid("voids"),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => user.id),
    at: tz("at").notNull(),
  },
  (t) => [
    // The undo FK's target; it also serves reading a Campaign's marks.
    unique("campaign_outcomes_mark_key").on(t.workspaceId, t.campaignId, t.personId, t.kind, t.id),
    // One undo per mark.
    unique("campaign_outcomes_voids_key").on(t.voids),
    foreignKey({ name: "campaign_outcomes_person_fk", columns: [t.workspaceId, t.campaignId, t.personId], foreignColumns: [campaignPeople.workspaceId, campaignPeople.campaignId, campaignPeople.personId] }),
    // The FK matches Workspace, Campaign, Person and kind; migration 0155
    // adds the insert trigger that restricts the target to a mark (voids is null).
    foreignKey({ name: "campaign_outcomes_voids_fk", columns: [t.workspaceId, t.campaignId, t.personId, t.kind, t.voids], foreignColumns: [t.workspaceId, t.campaignId, t.personId, t.kind, t.id] }),
    check("campaign_outcomes_kind_check", sql`${t.kind} in ('meeting', 'deal')`),
    check("campaign_outcomes_occurred_on_check", sql`(${t.voids} is null) = (${t.occurredOn} is not null)`),
    check("campaign_outcomes_voids_self_check", sql`${t.voids} is distinct from ${t.id}`),
  ],
);

// What Direx wrote once a Campaign ended (spec 2026-11-20 campaign-write-up): one row per Campaign,
// written by the campaign_writer agent and kept while its Workspace exists. `writing` holds the place
// while a run is out, so two sweeps start one run. Write it again updates the row; nothing deletes it.
export const campaignWriteUps = pgTable(
  "campaign_write_ups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    status: text("status").notNull(),
    paragraph: text("paragraph"),
    // Reading ids the paragraph uses.
    cites: jsonb("cites").notNull().default([]),
    // Up to three { assumption, because, readingIds, outcome? }, outcome once its Item is decided.
    suggestions: jsonb("suggestions").notNull().default([]),
    runId: uuid("run_id"),
    itemId: uuid("item_id"),
    failure: text("failure"),
    createdAt: tz("created_at").notNull(),
    writtenAt: tz("written_at"),
  },
  (t) => [
    unique("campaign_write_ups_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("campaign_write_ups_campaign_key").on(t.workspaceId, t.campaignId),
    foreignKey({ name: "campaign_write_ups_campaign_fk", columns: [t.workspaceId, t.campaignId], foreignColumns: [campaigns.workspaceId, campaigns.id] }),
    foreignKey({ name: "campaign_write_ups_item_fk", columns: [t.workspaceId, t.itemId], foreignColumns: [items.workspaceId, items.id] }),
    check("campaign_write_ups_status_check", sql`${t.status} in ('writing', 'written', 'failed')`),
    // Writing again keeps the old paragraph until the new run passes, so only `written` needs one.
    check("campaign_write_ups_written_check", sql`${t.status} <> 'written' or (${t.paragraph} is not null and ${t.writtenAt} is not null)`),
    check("campaign_write_ups_failure_check", sql`(${t.status} = 'failed') = (${t.failure} is not null)`),
    check("campaign_write_ups_suggestions_check", sql`jsonb_typeof(${t.suggestions}) = 'array' and jsonb_array_length(${t.suggestions}) <= 3`),
    check("campaign_write_ups_cites_check", sql`jsonb_typeof(${t.cites}) = 'array'`),
  ],
);
