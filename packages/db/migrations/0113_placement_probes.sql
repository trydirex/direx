CREATE TABLE "placement_probes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"day" date NOT NULL,
	"list_version" integer NOT NULL,
	"kind" text NOT NULL,
	"seq" integer NOT NULL,
	"peer" text NOT NULL,
	"expected_at" timestamp with time zone NOT NULL,
	"action_id" uuid,
	"message_id" text,
	"skip_reason" text,
	"verdict" text,
	"read_at" timestamp with time zone,
	"reported_verdict" text,
	"reported_at" timestamp with time zone,
	"archive_action_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "placement_probes_once_key" UNIQUE("workspace_id","credential_id","direction","day","peer","kind"),
	CONSTRAINT "placement_probes_direction_check" CHECK ("placement_probes"."direction" in ('send', 'receive')),
	CONSTRAINT "placement_probes_kind_check" CHECK ("placement_probes"."kind" in ('plain', 'content')),
	CONSTRAINT "placement_probes_verdict_check" CHECK ("placement_probes"."verdict" in ('primary', 'other_tab', 'spam', 'missing', 'query_failure')),
	CONSTRAINT "placement_probes_reported_verdict_check" CHECK ("placement_probes"."reported_verdict" in ('primary', 'other_tab', 'spam', 'missing', 'query_failure'))
);
--> statement-breakpoint
ALTER TABLE "placement_grants" DROP CONSTRAINT "placement_grants_stop_check";--> statement-breakpoint
ALTER TABLE "placement_probes" ADD CONSTRAINT "placement_probes_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_probes" ADD CONSTRAINT "placement_probes_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_probes" ADD CONSTRAINT "placement_probes_action_fk" FOREIGN KEY ("workspace_id","action_id") REFERENCES "public"."actions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_probes" ADD CONSTRAINT "placement_probes_archive_action_fk" FOREIGN KEY ("workspace_id","archive_action_id") REFERENCES "public"."actions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "placement_probes_action_idx" ON "placement_probes" USING btree ("workspace_id","action_id");--> statement-breakpoint
ALTER TABLE "placement_grants" ADD CONSTRAINT "placement_grants_stop_check" CHECK (("placement_grants"."stopped_at" is null and "placement_grants"."stopped_by" is null and "placement_grants"."stop_reason" is null) or ("placement_grants"."answer" = 'yes' and "placement_grants"."stopped_at" is not null and length("placement_grants"."stop_reason") between 1 and 500));--> statement-breakpoint
-- Forced RLS, same workspace policy as every Workspace table.
ALTER TABLE placement_probes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE placement_probes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON placement_probes
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- A check's row is kept: it is how a report tells a skipped check from a missing one.
REVOKE DELETE ON placement_probes FROM direx_app;
