// SPDX-License-Identifier: AGPL-3.0-only
// Finding companies and the people to contact there: a run, the companies it found, what was read on
// their sites, and saved cohorts. Rows are kept as evidence; only expired snapshots are deleted.
import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { agentRuns } from "./schema-agents";
import { items, people, workspaces } from "./schema";
import { campaigns } from "./schema-campaigns";

const tz = (name: string) => timestamp(name, { withTimezone: true });

// Vendor costs only, in micro-dollars. Model cost stays in model_calls.
export const prospectRuns = pgTable(
  "prospect_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    source: text("source").notNull(),
    terms: text("terms").array().notNull().default(sql`'{}'`),
    signals: text("signals").array().notNull().default(sql`'{}'`),
    companyLimit: integer("company_limit").notNull(),
    confirmedMicros: bigint("confirmed_micros", { mode: "bigint" }).notNull(),
    searchCostMicros: bigint("search_cost_micros", { mode: "bigint" }).notNull().default(sql`0`),
    verifyCostMicros: bigint("verify_cost_micros", { mode: "bigint" }).notNull().default(sql`0`),
    status: text("status").notNull().default("running"),
    confirmedBy: uuid("confirmed_by")
      .notNull()
      .references(() => user.id),
    createdAt: tz("created_at").notNull(),
    updatedAt: tz("updated_at").notNull(),
    finishedAt: tz("finished_at"),
  },
  (t) => [
    unique("prospect_runs_workspace_id_id_key").on(t.workspaceId, t.id),
    foreignKey({ name: "prospect_runs_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    index("prospect_runs_recent_idx").on(t.workspaceId, t.createdAt),
    check("prospect_runs_source_check", sql`${t.source} in ('search', 'pasted')`),
    // stopped: the run reached its confirmed amount and kept what it had.
    check("prospect_runs_status_check", sql`${t.status} in ('running', 'done', 'stopped', 'failed')`),
    check("prospect_runs_finished_check", sql`(${t.status} = 'running') = (${t.finishedAt} is null)`),
    check("prospect_runs_company_limit_check", sql`${t.companyLimit} > 0`),
    check("prospect_runs_money_check", sql`${t.confirmedMicros} >= 0 and ${t.searchCostMicros} >= 0 and ${t.verifyCostMicros} >= 0`),
  ],
);

// A company is known once per Workspace, so a second run never reads or pays for it again.
export const prospectCompanies = pgTable(
  "prospect_companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    domain: text("domain").notNull(),
    name: text("name"),
    website: text("website").notNull(),
    country: text("country"),
    countryQuote: text("country_quote"),
    firstRunId: uuid("first_run_id").notNull(),
    readStatus: text("read_status").notNull().default("pending"),
    readReason: text("read_reason"),
    // Who works there comes from a model run after the read. Null until the read is recorded.
    namesStatus: text("names_status"),
    namesReason: text("names_reason"),
    reviewItemId: uuid("review_item_id"),
    state: text("state").notNull().default("new"),
    createdAt: tz("created_at").notNull(),
    updatedAt: tz("updated_at").notNull(),
  },
  (t) => [
    unique("prospect_companies_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("prospect_companies_domain_key").on(t.workspaceId, t.domain),
    unique("prospect_companies_review_item_key").on(t.workspaceId, t.reviewItemId),
    foreignKey({ name: "prospect_companies_run_fk", columns: [t.workspaceId, t.firstRunId], foreignColumns: [prospectRuns.workspaceId, prospectRuns.id] }),
    foreignKey({ name: "prospect_companies_review_item_fk", columns: [t.workspaceId, t.reviewItemId], foreignColumns: [items.workspaceId, items.id] }),
    index("prospect_companies_run_idx").on(t.workspaceId, t.firstRunId, t.createdAt),
    index("prospect_companies_state_idx").on(t.workspaceId, t.state, t.createdAt),
    // Lowercase host with no www., so the same site never lands twice.
    check("prospect_companies_domain_check", sql`${t.domain} = lower(${t.domain}) and ${t.domain} !~ '^www\\.'`),
    check("prospect_companies_country_check", sql`${t.country} ~ '^[A-Z]{2}$'`),
    check("prospect_companies_country_quote_check", sql`${t.country} is not null or ${t.countryQuote} is null`),
    check("prospect_companies_read_status_check", sql`${t.readStatus} in ('pending', 'read', 'not_read')`),
    // A site that could not be read always says why.
    check("prospect_companies_read_reason_check", sql`(${t.readStatus} = 'not_read') = (${t.readReason} is not null)`),
    check("prospect_companies_state_check", sql`${t.state} in ('new', 'in_review', 'accepted', 'rejected')`),
    check("prospect_companies_names_status_check", sql`${t.namesStatus} in ('pending', 'done', 'skipped')`),
    // Names that were never read always say why.
    check("prospect_companies_names_reason_check", sql`(${t.namesStatus} is not distinct from 'skipped') = (${t.namesReason} is not null)`),
  ],
);

// One page as it was read. Text is capped by the reader, and expires_at is set only for a rejected
// company, whose snapshots are the one thing the product deletes.
export const prospectSnapshots = pgTable(
  "prospect_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    companyId: uuid("company_id").notNull(),
    pageUrl: text("page_url").notNull(),
    digest: text("digest").notNull(),
    text: text("text").notNull(),
    readAt: tz("read_at").notNull(),
    expiresAt: tz("expires_at"),
  },
  (t) => [
    unique("prospect_snapshots_workspace_id_id_key").on(t.workspaceId, t.id),
    foreignKey({ name: "prospect_snapshots_company_fk", columns: [t.workspaceId, t.companyId], foreignColumns: [prospectCompanies.workspaceId, prospectCompanies.id] }),
    index("prospect_snapshots_company_idx").on(t.workspaceId, t.companyId),
  ],
);

// Every quote is taken from its snapshot by code. Deleting an expired snapshot takes its
// signals with it: they belong to a rejected company and mean nothing without the page.
export const prospectSignals = pgTable(
  "prospect_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    companyId: uuid("company_id").notNull(),
    type: text("type").notNull(),
    quote: text("quote").notNull(),
    pageUrl: text("page_url").notNull(),
    snapshotId: uuid("snapshot_id").notNull(),
    observedOn: date("observed_on").notNull(),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    unique("prospect_signals_workspace_id_id_key").on(t.workspaceId, t.id),
    foreignKey({ name: "prospect_signals_company_fk", columns: [t.workspaceId, t.companyId], foreignColumns: [prospectCompanies.workspaceId, prospectCompanies.id] }),
    foreignKey({ name: "prospect_signals_snapshot_fk", columns: [t.workspaceId, t.snapshotId], foreignColumns: [prospectSnapshots.workspaceId, prospectSnapshots.id] }).onDelete("cascade"),
    index("prospect_signals_company_idx").on(t.workspaceId, t.companyId),
    index("prospect_signals_snapshot_idx").on(t.workspaceId, t.snapshotId),
    check("prospect_signals_type_check", sql`${t.type} in ('hiring', 'stale_blog')`),
  ],
);

// The evidence for contacting someone at a company. Lowercased email. A guessed address names its
// pattern and is kept only once it verifies. Like signals, it goes when its expired snapshot does.
export const prospectAddresses = pgTable(
  "prospect_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    companyId: uuid("company_id").notNull(),
    email: text("email").notNull(),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    pattern: text("pattern"),
    name: text("name"),
    role: text("role"),
    snapshotId: uuid("snapshot_id").notNull(),
    readAt: tz("read_at").notNull(),
    noticeFound: boolean("notice_found").notNull(),
    leftOutReason: text("left_out_reason"),
    verificationResult: text("verification_result"),
    verifiedAt: tz("verified_at"),
    personId: uuid("person_id"),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    unique("prospect_addresses_workspace_id_id_key").on(t.workspaceId, t.id),
    // Also the index for listing a company's addresses.
    unique("prospect_addresses_company_email_key").on(t.workspaceId, t.companyId, t.email),
    foreignKey({ name: "prospect_addresses_company_fk", columns: [t.workspaceId, t.companyId], foreignColumns: [prospectCompanies.workspaceId, prospectCompanies.id] }),
    foreignKey({ name: "prospect_addresses_snapshot_fk", columns: [t.workspaceId, t.snapshotId], foreignColumns: [prospectSnapshots.workspaceId, prospectSnapshots.id] }).onDelete("cascade"),
    foreignKey({ name: "prospect_addresses_person_fk", columns: [t.workspaceId, t.personId], foreignColumns: [people.workspaceId, people.id] }),
    index("prospect_addresses_snapshot_idx").on(t.workspaceId, t.snapshotId),
    index("prospect_addresses_person_idx").on(t.workspaceId, t.personId),
    check("prospect_addresses_email_check", sql`${t.email} = lower(${t.email})`),
    // unknown: not a shared mailbox, and no one known by it yet.
    check("prospect_addresses_kind_check", sql`${t.kind} in ('named', 'function', 'generic', 'unknown')`),
    check("prospect_addresses_source_check", sql`${t.source} in ('published', 'guessed')`),
    check("prospect_addresses_pattern_check", sql`${t.pattern} in ('first', 'first.last')`),
    check("prospect_addresses_guess_check", sql`(${t.source} = 'guessed') = (${t.pattern} is not null)`),
    // A guess is made only for a named person.
    check("prospect_addresses_guess_named_check", sql`${t.source} = 'published' or (${t.kind} = 'named' and ${t.name} is not null)`),
    check("prospect_addresses_verification_check", sql`${t.verificationResult} in ('deliverable', 'invalid', 'catch_all', 'unknown', 'other')`),
    check("prospect_addresses_verified_at_check", sql`(${t.verificationResult} is null) = (${t.verifiedAt} is null)`),
  ],
);

// Someone who works at a company, as a names run reported them and code found them on its snapshots.
export const prospectPeople = pgTable(
  "prospect_people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    companyId: uuid("company_id").notNull(),
    first: text("first").notNull(),
    last: text("last").notNull(),
    role: text("role"),
    namesRunId: uuid("names_run_id"),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    unique("prospect_people_workspace_id_id_key").on(t.workspaceId, t.id),
    // Also the index for listing a company's people.
    unique("prospect_people_company_name_key").on(t.workspaceId, t.companyId, t.first, t.last),
    foreignKey({ name: "prospect_people_company_fk", columns: [t.workspaceId, t.companyId], foreignColumns: [prospectCompanies.workspaceId, prospectCompanies.id] }),
    foreignKey({ name: "prospect_people_run_fk", columns: [t.workspaceId, t.namesRunId], foreignColumns: [agentRuns.workspaceId, agentRuns.id] }),
  ],
);

// A saved filter, not a list: it refills as companies are accepted.
export const prospectCohorts = pgTable(
  "prospect_cohorts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    filter: jsonb("filter").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: tz("created_at").notNull(),
    updatedAt: tz("updated_at").notNull(),
  },
  (t) => [
    unique("prospect_cohorts_workspace_id_id_key").on(t.workspaceId, t.id),
    foreignKey({ name: "prospect_cohorts_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
  ],
);

// Handing a cohort to a Campaign, worked in batches by a background job. The cursor is the last address
// done, saved with that batch's results, so a retried job carries on where it stopped.
export const prospectHandovers = pgTable(
  "prospect_handovers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    cohortId: uuid("cohort_id").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    status: text("status").notNull().default("running"),
    cursor: uuid("cursor"),
    pendingAddressIds: uuid("pending_address_ids").array(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: tz("created_at").notNull(),
    finishedAt: tz("finished_at"),
    // Why a hand-over stopped before the end: the job's last try failed, so a person knows to look.
    failureReason: text("failure_reason"),
  },
  (t) => [
    unique("prospect_handovers_workspace_id_id_key").on(t.workspaceId, t.id),
    foreignKey({ name: "prospect_handovers_cohort_fk", columns: [t.workspaceId, t.cohortId], foreignColumns: [prospectCohorts.workspaceId, prospectCohorts.id] }),
    foreignKey({ name: "prospect_handovers_campaign_fk", columns: [t.workspaceId, t.campaignId], foreignColumns: [campaigns.workspaceId, campaigns.id] }),
    check("prospect_handovers_status_check", sql`${t.status} in ('running', 'done', 'failed')`),
    check("prospect_handovers_failure_check", sql`(${t.status} = 'failed') = (${t.failureReason} is not null)`),
    check("prospect_handovers_finished_check", sql`(${t.status} = 'running') = (${t.finishedAt} is null)`),
  ],
);

// What a hand-over did with each address: one row each, so the outcome can be read after the job.
export const prospectHandoverResults = pgTable(
  "prospect_handover_results",
  {
    workspaceId: uuid("workspace_id").notNull(),
    handoverId: uuid("handover_id").notNull(),
    addressId: uuid("address_id").notNull(),
    status: text("status").notNull(),
    reason: text("reason"),
    personId: uuid("person_id"),
    conflictItemId: uuid("conflict_item_id"),
    missing: text("missing").array().notNull().default(sql`'{}'`),
    // The basis and evidence sent with the address, kept so a Person who went over with no country can
    // get them back once someone enters it.
    basis: text("basis"),
    evidence: text("evidence"),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    // Also the index for paging one hand-over's results in address order.
    primaryKey({ name: "prospect_handover_results_pkey", columns: [t.workspaceId, t.handoverId, t.addressId] }),
    foreignKey({ name: "prospect_handover_results_handover_fk", columns: [t.workspaceId, t.handoverId], foreignColumns: [prospectHandovers.workspaceId, prospectHandovers.id] }),
    // An expired snapshot takes its addresses with it, and so their results.
    foreignKey({ name: "prospect_handover_results_address_fk", columns: [t.workspaceId, t.addressId], foreignColumns: [prospectAddresses.workspaceId, prospectAddresses.id] }).onDelete("cascade"),
    foreignKey({ name: "prospect_handover_results_person_fk", columns: [t.workspaceId, t.personId], foreignColumns: [people.workspaceId, people.id] }),
    foreignKey({ name: "prospect_handover_results_item_fk", columns: [t.workspaceId, t.conflictItemId], foreignColumns: [items.workspaceId, items.id] }),
    index("prospect_handover_results_address_idx").on(t.workspaceId, t.addressId),
    check("prospect_handover_results_status_check", sql`${t.status} in ('added', 'joined', 'conflict', 'left_out')`),
    check("prospect_handover_results_reason_check", sql`(${t.status} = 'left_out') = (${t.reason} is not null)`),
    check("prospect_handover_results_person_check", sql`${t.status} = 'left_out' or ${t.personId} is not null`),
  ],
);

// The latest search terms a terms run proposed, one row per Workspace, which a person edits before any
// search. Only terms already checked to hold no Person data are kept; dropped counts the rest.
export const prospectTerms = pgTable(
  "prospect_terms",
  {
    workspaceId: uuid("workspace_id").primaryKey(),
    runId: uuid("run_id").notNull(),
    terms: text("terms").array().notNull(),
    objective: text("objective"),
    dropped: integer("dropped").notNull(),
    proposedAt: tz("proposed_at").notNull(),
  },
  (t) => [
    foreignKey({ name: "prospect_terms_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "prospect_terms_run_fk", columns: [t.workspaceId, t.runId], foreignColumns: [agentRuns.workspaceId, agentRuns.id] }),
    check("prospect_terms_count_check", sql`cardinality(${t.terms}) <= 5 and ${t.dropped} >= 0`),
  ],
);
