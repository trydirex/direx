CREATE TABLE "prospect_terms" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"terms" text[] NOT NULL,
	"objective" text,
	"dropped" integer NOT NULL,
	"proposed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "prospect_terms_count_check" CHECK (cardinality("prospect_terms"."terms") <= 5 and "prospect_terms"."dropped" >= 0)
);
--> statement-breakpoint
ALTER TABLE "prospect_terms" ADD CONSTRAINT "prospect_terms_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_terms" ADD CONSTRAINT "prospect_terms_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."agent_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Forced RLS, same workspace policy as the other prospecting tables.
ALTER TABLE prospect_terms ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE prospect_terms FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON prospect_terms
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
