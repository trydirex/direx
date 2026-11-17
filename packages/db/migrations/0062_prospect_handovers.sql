CREATE TABLE "prospect_handover_results" (
	"workspace_id" uuid NOT NULL,
	"handover_id" uuid NOT NULL,
	"address_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"person_id" uuid,
	"conflict_item_id" uuid,
	"missing" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "prospect_handover_results_pkey" PRIMARY KEY("workspace_id","handover_id","address_id"),
	CONSTRAINT "prospect_handover_results_status_check" CHECK ("prospect_handover_results"."status" in ('added', 'joined', 'conflict', 'left_out')),
	CONSTRAINT "prospect_handover_results_reason_check" CHECK (("prospect_handover_results"."status" = 'left_out') = ("prospect_handover_results"."reason" is not null)),
	CONSTRAINT "prospect_handover_results_person_check" CHECK ("prospect_handover_results"."status" = 'left_out' or "prospect_handover_results"."person_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "prospect_handovers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"cohort_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"cursor" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "prospect_handovers_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "prospect_handovers_status_check" CHECK ("prospect_handovers"."status" in ('running', 'done')),
	CONSTRAINT "prospect_handovers_finished_check" CHECK (("prospect_handovers"."status" = 'running') = ("prospect_handovers"."finished_at" is null))
);
--> statement-breakpoint
ALTER TABLE "prospect_handover_results" ADD CONSTRAINT "prospect_handover_results_handover_fk" FOREIGN KEY ("workspace_id","handover_id") REFERENCES "public"."prospect_handovers"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_handover_results" ADD CONSTRAINT "prospect_handover_results_address_fk" FOREIGN KEY ("workspace_id","address_id") REFERENCES "public"."prospect_addresses"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_handover_results" ADD CONSTRAINT "prospect_handover_results_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_handover_results" ADD CONSTRAINT "prospect_handover_results_item_fk" FOREIGN KEY ("workspace_id","conflict_item_id") REFERENCES "public"."items"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_handovers" ADD CONSTRAINT "prospect_handovers_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_handovers" ADD CONSTRAINT "prospect_handovers_cohort_fk" FOREIGN KEY ("workspace_id","cohort_id") REFERENCES "public"."prospect_cohorts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_handovers" ADD CONSTRAINT "prospect_handovers_campaign_fk" FOREIGN KEY ("workspace_id","campaign_id") REFERENCES "public"."campaigns"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prospect_handover_results_address_idx" ON "prospect_handover_results" USING btree ("workspace_id","address_id");--> statement-breakpoint
-- Forced RLS, same workspace policy as the other prospecting tables.
ALTER TABLE prospect_handovers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE prospect_handovers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON prospect_handovers
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE prospect_handover_results ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE prospect_handover_results FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON prospect_handover_results
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- What was handed over is a record, like the rest of prospecting, and is never deleted.
REVOKE DELETE ON prospect_handovers, prospect_handover_results FROM direx_app;
