CREATE TABLE "placement_content_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "placement_content_tests_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"receivers" text[] NOT NULL,
	"wording_version" text NOT NULL,
	"said_by" uuid NOT NULL,
	"said_at" timestamp with time zone NOT NULL,
	CONSTRAINT "placement_content_tests_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "placement_content_tests_receivers_check" CHECK (cardinality("placement_content_tests"."receivers") between 1 and 50)
);
--> statement-breakpoint
ALTER TABLE "placement_content_tests" ADD CONSTRAINT "placement_content_tests_said_by_user_id_fk" FOREIGN KEY ("said_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_content_tests" ADD CONSTRAINT "placement_content_tests_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_content_tests" ADD CONSTRAINT "placement_content_tests_step_fk" FOREIGN KEY ("workspace_id","campaign_id","step_key") REFERENCES "public"."campaign_steps"("workspace_id","campaign_id","step_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "placement_content_tests_current_idx" ON "placement_content_tests" USING btree ("workspace_id","campaign_id","step_key","seq");--> statement-breakpoint
-- Forced RLS, same workspace policy as every Workspace table.
ALTER TABLE placement_content_tests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE placement_content_tests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON placement_content_tests
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- A yes is a record: a new yes adds a row, and none is changed or removed.
REVOKE UPDATE, DELETE ON placement_content_tests FROM direx_app;
