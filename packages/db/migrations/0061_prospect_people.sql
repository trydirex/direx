CREATE TABLE "prospect_people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"first" text NOT NULL,
	"last" text NOT NULL,
	"role" text,
	"names_run_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "prospect_people_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "prospect_people_company_name_key" UNIQUE("workspace_id","company_id","first","last")
);
--> statement-breakpoint
ALTER TABLE "prospect_addresses" DROP CONSTRAINT "prospect_addresses_kind_check";--> statement-breakpoint
ALTER TABLE "prospect_companies" ADD COLUMN "names_status" text;--> statement-breakpoint
ALTER TABLE "prospect_companies" ADD COLUMN "names_reason" text;--> statement-breakpoint
ALTER TABLE "prospect_people" ADD CONSTRAINT "prospect_people_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."prospect_companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_people" ADD CONSTRAINT "prospect_people_run_fk" FOREIGN KEY ("workspace_id","names_run_id") REFERENCES "public"."agent_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_addresses" ADD CONSTRAINT "prospect_addresses_kind_check" CHECK ("prospect_addresses"."kind" in ('named', 'function', 'generic', 'unknown'));--> statement-breakpoint
ALTER TABLE "prospect_companies" ADD CONSTRAINT "prospect_companies_names_status_check" CHECK ("prospect_companies"."names_status" in ('pending', 'done', 'skipped'));--> statement-breakpoint
ALTER TABLE "prospect_companies" ADD CONSTRAINT "prospect_companies_names_reason_check" CHECK (("prospect_companies"."names_status" is not distinct from 'skipped') = ("prospect_companies"."names_reason" is not null));--> statement-breakpoint
-- Forced RLS, same workspace policy as the other prospecting tables.
ALTER TABLE prospect_people ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE prospect_people FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON prospect_people
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- People are evidence like addresses, and are never deleted.
REVOKE DELETE ON prospect_people FROM direx_app;
