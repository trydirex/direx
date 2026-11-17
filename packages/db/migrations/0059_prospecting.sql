CREATE TABLE "prospect_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"email" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"pattern" text,
	"name" text,
	"role" text,
	"snapshot_id" uuid NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	"notice_found" boolean NOT NULL,
	"left_out_reason" text,
	"verification_result" text,
	"verified_at" timestamp with time zone,
	"person_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "prospect_addresses_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "prospect_addresses_company_email_key" UNIQUE("workspace_id","company_id","email"),
	CONSTRAINT "prospect_addresses_email_check" CHECK ("prospect_addresses"."email" = lower("prospect_addresses"."email")),
	CONSTRAINT "prospect_addresses_kind_check" CHECK ("prospect_addresses"."kind" in ('named', 'function', 'generic')),
	CONSTRAINT "prospect_addresses_source_check" CHECK ("prospect_addresses"."source" in ('published', 'guessed')),
	CONSTRAINT "prospect_addresses_pattern_check" CHECK ("prospect_addresses"."pattern" in ('first', 'first.last')),
	CONSTRAINT "prospect_addresses_guess_check" CHECK (("prospect_addresses"."source" = 'guessed') = ("prospect_addresses"."pattern" is not null)),
	CONSTRAINT "prospect_addresses_guess_named_check" CHECK ("prospect_addresses"."source" = 'published' or ("prospect_addresses"."kind" = 'named' and "prospect_addresses"."name" is not null)),
	CONSTRAINT "prospect_addresses_verification_check" CHECK ("prospect_addresses"."verification_result" in ('deliverable', 'invalid', 'catch_all', 'unknown', 'other')),
	CONSTRAINT "prospect_addresses_verified_at_check" CHECK (("prospect_addresses"."verification_result" is null) = ("prospect_addresses"."verified_at" is null))
);
--> statement-breakpoint
CREATE TABLE "prospect_cohorts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"filter" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "prospect_cohorts_workspace_id_id_key" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "prospect_companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"name" text,
	"website" text NOT NULL,
	"country" text,
	"country_quote" text,
	"first_run_id" uuid NOT NULL,
	"read_status" text DEFAULT 'pending' NOT NULL,
	"read_reason" text,
	"review_item_id" uuid,
	"state" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "prospect_companies_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "prospect_companies_domain_key" UNIQUE("workspace_id","domain"),
	CONSTRAINT "prospect_companies_review_item_key" UNIQUE("workspace_id","review_item_id"),
	CONSTRAINT "prospect_companies_domain_check" CHECK ("prospect_companies"."domain" = lower("prospect_companies"."domain") and "prospect_companies"."domain" !~ '^www\.'),
	CONSTRAINT "prospect_companies_country_check" CHECK ("prospect_companies"."country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "prospect_companies_country_quote_check" CHECK ("prospect_companies"."country" is not null or "prospect_companies"."country_quote" is null),
	CONSTRAINT "prospect_companies_read_status_check" CHECK ("prospect_companies"."read_status" in ('pending', 'read', 'not_read')),
	CONSTRAINT "prospect_companies_read_reason_check" CHECK (("prospect_companies"."read_status" = 'not_read') = ("prospect_companies"."read_reason" is not null)),
	CONSTRAINT "prospect_companies_state_check" CHECK ("prospect_companies"."state" in ('new', 'in_review', 'accepted', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "prospect_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source" text NOT NULL,
	"terms" text[] DEFAULT '{}' NOT NULL,
	"signals" text[] DEFAULT '{}' NOT NULL,
	"company_limit" integer NOT NULL,
	"confirmed_micros" bigint NOT NULL,
	"search_cost_micros" bigint DEFAULT 0 NOT NULL,
	"verify_cost_micros" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"confirmed_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "prospect_runs_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "prospect_runs_source_check" CHECK ("prospect_runs"."source" in ('search', 'pasted')),
	CONSTRAINT "prospect_runs_status_check" CHECK ("prospect_runs"."status" in ('running', 'done', 'stopped', 'failed')),
	CONSTRAINT "prospect_runs_finished_check" CHECK (("prospect_runs"."status" = 'running') = ("prospect_runs"."finished_at" is null)),
	CONSTRAINT "prospect_runs_company_limit_check" CHECK ("prospect_runs"."company_limit" > 0),
	CONSTRAINT "prospect_runs_money_check" CHECK ("prospect_runs"."confirmed_micros" >= 0 and "prospect_runs"."search_cost_micros" >= 0 and "prospect_runs"."verify_cost_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "prospect_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"quote" text NOT NULL,
	"page_url" text NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"observed_on" date NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "prospect_signals_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "prospect_signals_type_check" CHECK ("prospect_signals"."type" in ('hiring', 'stale_blog'))
);
--> statement-breakpoint
CREATE TABLE "prospect_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"page_url" text NOT NULL,
	"digest" text NOT NULL,
	"text" text NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "prospect_snapshots_workspace_id_id_key" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "prospect_addresses" ADD CONSTRAINT "prospect_addresses_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."prospect_companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_addresses" ADD CONSTRAINT "prospect_addresses_snapshot_fk" FOREIGN KEY ("workspace_id","snapshot_id") REFERENCES "public"."prospect_snapshots"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_addresses" ADD CONSTRAINT "prospect_addresses_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_cohorts" ADD CONSTRAINT "prospect_cohorts_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_cohorts" ADD CONSTRAINT "prospect_cohorts_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_companies" ADD CONSTRAINT "prospect_companies_run_fk" FOREIGN KEY ("workspace_id","first_run_id") REFERENCES "public"."prospect_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_companies" ADD CONSTRAINT "prospect_companies_review_item_fk" FOREIGN KEY ("workspace_id","review_item_id") REFERENCES "public"."items"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_runs" ADD CONSTRAINT "prospect_runs_confirmed_by_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_runs" ADD CONSTRAINT "prospect_runs_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_signals" ADD CONSTRAINT "prospect_signals_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."prospect_companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_signals" ADD CONSTRAINT "prospect_signals_snapshot_fk" FOREIGN KEY ("workspace_id","snapshot_id") REFERENCES "public"."prospect_snapshots"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_snapshots" ADD CONSTRAINT "prospect_snapshots_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."prospect_companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prospect_addresses_snapshot_idx" ON "prospect_addresses" USING btree ("workspace_id","snapshot_id");--> statement-breakpoint
CREATE INDEX "prospect_addresses_person_idx" ON "prospect_addresses" USING btree ("workspace_id","person_id");--> statement-breakpoint
CREATE INDEX "prospect_companies_run_idx" ON "prospect_companies" USING btree ("workspace_id","first_run_id","created_at");--> statement-breakpoint
CREATE INDEX "prospect_companies_state_idx" ON "prospect_companies" USING btree ("workspace_id","state","created_at");--> statement-breakpoint
CREATE INDEX "prospect_runs_recent_idx" ON "prospect_runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "prospect_signals_company_idx" ON "prospect_signals" USING btree ("workspace_id","company_id");--> statement-breakpoint
CREATE INDEX "prospect_signals_snapshot_idx" ON "prospect_signals" USING btree ("workspace_id","snapshot_id");--> statement-breakpoint
CREATE INDEX "prospect_snapshots_company_idx" ON "prospect_snapshots" USING btree ("workspace_id","company_id");
--> statement-breakpoint
-- Forced RLS on the prospecting tables, same workspace policy as the rest.
ALTER TABLE prospect_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE prospect_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON prospect_runs
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE prospect_companies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE prospect_companies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON prospect_companies
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE prospect_snapshots ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE prospect_snapshots FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON prospect_snapshots
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE prospect_signals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE prospect_signals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON prospect_signals
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE prospect_addresses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE prospect_addresses FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON prospect_addresses
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE prospect_cohorts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE prospect_cohorts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON prospect_cohorts
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Rows are evidence and are never deleted. Expired snapshots are the one exception, and deleting one
-- removes the signals and addresses read from it.
REVOKE DELETE ON prospect_runs, prospect_companies, prospect_signals, prospect_addresses, prospect_cohorts FROM direx_app;
