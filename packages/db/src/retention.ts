// SPDX-License-Identifier: AGPL-3.0-only
// How long each table is kept (ADR 0030 rules 001, 002, 005 and 006). One entry per table of the
// migrated catalogue, schema-qualified; packages/db/test/catalog.ts fails on a table without one and on
// an entry without a table. A new table adds its entry in the same change.
//
// Tenant tables (those with a workspace_id):
//   audit        kept while its Workspace exists; removed by the Workspace purge.
//   operational  pruned after `window`, a predicate of terminal state and age over the table's own
//                columns, longer than every guard in `readers` that reads the table. `sweep` names what
//                prunes it: a system definer the daily retention sweep calls in list order (its body
//                holds `window` word for word, which the catalogue check reads), or the app path.
//   suppression  turned into deployment-level keyed hashes at purge (ADR 0030 Q6).
// Other tables:
//   account        sign-in tables; never purged with one Workspace.
//   organization   removed after its last Workspace is purged.
//   deployment     the system schema and the root key; survive every purge.
//   infrastructure the job queue and the migration record.
//
// `appDeletes` marks the tables direx_app may DELETE from today. The catalogue check fails when the app
// holds DELETE on any other table, so a revoke stays revoked.

export type TenantClass = "audit" | "operational" | "suppression";
export type OtherClass = "account" | "organization" | "deployment" | "infrastructure";
export type RetentionClass = TenantClass | OtherClass;

export type Retention =
  | { class: Exclude<RetentionClass, "operational">; appDeletes?: true }
  | { class: "operational"; window: string; readers: readonly string[]; sweep: string; appDeletes?: true };

export const TENANT_CLASSES: readonly RetentionClass[] = ["audit", "operational", "suppression"];

const audit = { class: "audit" } as const;
const auditDeletable = { class: "audit", appDeletes: true } as const;
const account = { class: "account", appDeletes: true } as const;
const deployment = { class: "deployment" } as const;
const queue = { class: "infrastructure", appDeletes: true } as const;

export const RETENTION: Readonly<Record<string, Retention>> = {
  "auth.account": account,
  "auth.session": account,
  "auth.user": account,
  "auth.verification": account,

  "drizzle.__drizzle_migrations": { class: "infrastructure" },
  "pgboss.bam": queue,
  "pgboss.instance": queue,
  "pgboss.job": queue,
  "pgboss.job_dependency": queue,
  "pgboss.queue": queue,
  "pgboss.queue_stats": queue,
  "pgboss.schedule": queue,
  "pgboss.subscription": queue,
  "pgboss.version": queue,
  "pgboss.warning": queue,

  "public.deployment_root_key": deployment,
  "public.organizations": { class: "organization" },
  "system.bootstrap_invites": deployment,
  "system.plugin_install_events": deployment,
  "system.plugin_installs": deployment,
  // What each Workspace purge removed (ADR 0030 rule 004), and the opt-outs purged Workspaces left as
  // keyed hashes (Q6). Both outlive every purge and every sweep.
  "system.purge_receipts": deployment,
  "system.server_admin_events": deployment,
  "system.server_admins": deployment,
  "system.server_settings": deployment,
  "system.suppression_hashes": deployment,
  "system.system_audit": deployment,

  // The windows the founder set (ADR 0030 Q1), swept by migration 0144. Model calls go before the
  // reservations they name.
  "public.trigger_events": {
    class: "operational",
    window: "received_at < now() - interval '90 days'",
    readers: ["apps/api/src/modules/plugins/adapters/trigger-repo.ts markNew: drops an event id already seen, against webhook retries and overlapping polls"],
    sweep: "system.sweep_trigger_events",
  },
  "public.model_calls": {
    class: "operational",
    window: "status <> 'dispatched' AND created_at < now() - interval '13 months'",
    readers: [
      "apps/api/src/modules/models/adapters/repo.ts: the idempotency key lookup, and spend by calendar month",
      "apps/api/src/modules/models/adapters/repo.ts: a run's calls and their reservations",
    ],
    sweep: "system.sweep_model_calls",
  },
  // model_calls (workspace_id, reservation_id) is indexed for this window's NOT EXISTS and the foreign key
  // check on each deleted reservation.
  "public.budget_reservations": {
    class: "operational",
    window:
      "status <> 'held' AND settled_at < now() - interval '90 days' AND NOT EXISTS (SELECT 1 FROM public.model_calls m WHERE m.workspace_id = budget_reservations.workspace_id AND m.reservation_id = budget_reservations.id)",
    readers: [
      "apps/api/src/modules/ledger/adapters/budget-repo.ts withBudget: settled plus held spend for the calendar month",
      "public.model_calls.reservation_id: a foreign key, so a reservation a kept model call names stays",
    ],
    sweep: "system.sweep_budget_reservations",
  },
  "public.credential_access_events": {
    class: "operational",
    window: "at < now() - interval '1 year'",
    readers: ["apps/api/src/modules/credentials/adapters/repo.ts listEvents: a credential's latest uses, shown in Settings"],
    sweep: "system.sweep_credential_access_events",
  },
  "public.competitor_snapshots": {
    class: "operational",
    window:
      "read_at < now() - interval '1 year' AND EXISTS (SELECT 1 FROM public.competitor_snapshots n WHERE n.workspace_id = competitor_snapshots.workspace_id AND n.competitor_id = competitor_snapshots.competitor_id AND n.source = competitor_snapshots.source AND n.read_at > competitor_snapshots.read_at)",
    readers: [
      "apps/api/src/modules/competitors/adapters/repo.ts hasSnapshot, lastGood, lastReads: one read per page per week, and the newest reads as the baseline",
      "public.competitor_changes: its before and after snapshots cascade on delete, so a pruned snapshot takes its Changes with it",
    ],
    sweep: "system.sweep_competitor_snapshots",
    appDeletes: true,
  },
  // Pruned by the app as it counts (apps/api/src/modules/door/application/requests.ts), which holds DELETE.
  "public.door_counters": {
    class: "operational",
    window: "minute < now() - interval '10 minutes'",
    readers: ["apps/api/src/modules/door/application/requests.ts: the per-minute request limit"],
    sweep: "apps/api/src/modules/door/adapters/repo.ts, as it counts",
    appDeletes: true,
  },

  // An opt-out outlives its Workspace as a keyed hash (ADR 0030 Q6).
  "public.suppressions": { class: "suppression" },

  "public.action_events": audit,
  "public.actions": audit,
  "public.agent_cancellations": audit,
  "public.agent_lesson_events": audit,
  "public.agent_lesson_versions": audit,
  "public.agent_lessons": audit,
  "public.agent_model_choice_revisions": audit,
  "public.agent_model_choices": auditDeletable,
  "public.agent_proposals": audit,
  "public.agent_run_events": audit,
  "public.agent_run_lessons": audit,
  "public.agent_run_parts": audit,
  "public.agent_runs": audit,
  "public.agent_setting_revisions": audit,
  "public.agent_settings": audit,
  "public.approval_keys": audit,
  "public.approvals": audit,
  "public.ask_messages": audit,
  "public.ask_starts": audit,
  "public.brand_sample_revisions": audit,
  "public.brand_samples": audit,
  "public.campaign_actions": audit,
  "public.campaign_dms": audit,
  "public.campaign_write_ups": audit,
  "public.campaign_outcomes": audit,
  "public.campaign_people": audit,
  "public.campaign_plan_changes": audit,
  "public.campaign_settlements": audit,
  "public.campaign_step_mailboxes": auditDeletable,
  "public.campaign_step_outputs": audit,
  "public.campaign_steps": audit,
  "public.campaigns": audit,
  "public.clip_runs": audit,
  "public.clip_step_runs": audit,
  "public.clips": audit,
  "public.competitor_changes": auditDeletable,
  "public.competitor_finds": audit,
  "public.competitor_proposals": audit,
  "public.competitors": auditDeletable,
  "public.connect_links": audit,
  "public.correspondents": auditDeletable,
  "public.credentials": audit,
  "public.doc_rows": audit,
  "public.doc_sources": audit,
  "public.doc_write_grants": audit,
  // A proposal's idempotency record: no content, only the body's SHA-256, kept as long as the requests are,
  // so a retry is always answered with the Item it made.
  "public.door_proposals": audit,
  "public.door_requests": audit,
  "public.external_tokens": audit,
  "public.fact_versions": audit,
  "public.facts": audit,
  "public.hold_hooks": audit,
  "public.hold_releases": audit,
  "public.ideas": audit,
  "public.identity_keys": audit,
  "public.item_events": audit,
  "public.items": audit,
  "public.mailbox_header_checks": audit,
  "public.mailbox_reservations": audit,
  "public.mailbox_setting_changes": audit,
  "public.marketing_plan_versions": audit,
  "public.marketing_plans": audit,
  "public.media": audit,
  "public.model_budget_incidents": audit,
  "public.model_cli_sign_ins": auditDeletable,
  "public.model_connections": auditDeletable,
  "public.model_settings_revisions": audit,
  "public.newsletter_issues": audit,
  "public.newsletter_settings": auditDeletable,
  "public.newsletter_subscribers": audit,
  "public.note_comments": auditDeletable,
  "public.notes": auditDeletable,
  "public.outreach_settings": auditDeletable,
  "public.outside_touches": auditDeletable,
  "public.people": audit,
  // A consent record: removed by the purge with the ledger (ADR 0030 Q3); the export is the customer's copy.
  "public.person_eligibility": audit,
  "public.person_keys": auditDeletable,
  "public.person_links": audit,
  "public.placement_content_tests": audit,
  "public.placement_grants": audit,
  "public.placement_list_state": audit,
  "public.placement_member_keys": audit,
  "public.placement_probes": audit,
  "public.plan_measure_readings": audit,
  "public.plan_step_progress": audit,
  "public.plugin_webhooks": audit,
  "public.prospect_addresses": audit,
  "public.prospect_cohorts": audit,
  "public.prospect_companies": audit,
  "public.prospect_handover_results": audit,
  "public.prospect_handovers": audit,
  "public.prospect_people": audit,
  "public.prospect_runs": audit,
  "public.prospect_signals": audit,
  "public.prospect_snapshots": auditDeletable,
  "public.prospect_terms": auditDeletable,
  "public.relationship_holds": audit,
  "public.reply_signals": audit,
  "public.review_decisions": audit,
  "public.review_feeds": auditDeletable,
  "public.seo_briefs": audit,
  "public.social_account_health": audit,
  "public.social_accounts": auditDeletable,
  "public.social_pace_changes": audit,
  "public.social_posts": audit,
  "public.social_reservations": audit,
  "public.standing_rule_revisions": audit,
  "public.standing_rule_uses": auditDeletable,
  "public.standing_rules": audit,
  "public.strategies": audit,
  "public.strategy_versions": audit,
  // Not an opt-out but the record of one undone, holding the reply quote and the user who undid it,
  // which the hash table must not carry (ADR 0030 Q6). Its suppression row is already gone.
  "public.suppression_reversals": audit,
  "public.touch_reservations": audit,
  "public.trigger_cursors": audit,
  "public.unsubscribe_tokens": auditDeletable,
  // Tracked links (ADR 0035): kept while the Workspace exists, so links already sent keep redirecting
  // (rule 017). A domain may be removed while no link uses it (rule 008).
  "public.tracking_domains": auditDeletable,
  "public.tracked_links": audit,
  "public.tracked_link_uses": audit,
  "public.voice_entries": audit,
  "public.voice_versions": audit,
  "public.workspace_audit": audit,
  // Who exported and when; the ZIP itself goes after 24 hours (COLUMN_WINDOWS).
  "public.workspace_exports": audit,
  "public.workspace_invites": auditDeletable,
  "public.workspace_keys": audit,
  "public.workspace_members": auditDeletable,
  "public.workspace_plugins": auditDeletable,
  // Deleted by system.purge_finish once every other table holds none of its rows (ADR 0030 Q3).
  "public.workspaces": audit,
};

/** A column cleared on its own window while its row stays (ADR 0030 rule 006). */
export type ColumnWindow = { table: string; column: string; window: string; by: string };

export const COLUMN_WINDOWS: readonly ColumnWindow[] = [
  { table: "public.reply_signals", column: "text", window: "received_at < now() - interval '30 days'", by: "system.clear_old_reply_text (0045)" },
  // The bytes the key names are removed from storage, and bytes_removed_at stamped; the key stays.
  { table: "public.media", column: "storage_key", window: "kind = 'source' AND created_at < now() - interval '7 days'", by: "system.media_sweep_due (0080) and the media sweep job" },
  // The export ZIP the key names is removed 24 hours after it is ready, and removed_at stamped; the key stays.
  { table: "public.workspace_exports", column: "storage_key", window: "expires_at < now() OR failed_at IS NOT NULL", by: "system.export_sweep_due (0145) and the export sweep job" },
];
