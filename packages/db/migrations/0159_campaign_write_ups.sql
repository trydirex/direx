CREATE TABLE "campaign_write_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"status" text NOT NULL,
	"paragraph" text,
	"cites" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"run_id" uuid,
	"item_id" uuid,
	"failure" text,
	"created_at" timestamp with time zone NOT NULL,
	"written_at" timestamp with time zone,
	CONSTRAINT "campaign_write_ups_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "campaign_write_ups_campaign_key" UNIQUE("workspace_id","campaign_id"),
	CONSTRAINT "campaign_write_ups_status_check" CHECK ("campaign_write_ups"."status" in ('writing', 'written', 'failed')),
	CONSTRAINT "campaign_write_ups_written_check" CHECK ("campaign_write_ups"."status" <> 'written' or ("campaign_write_ups"."paragraph" is not null and "campaign_write_ups"."written_at" is not null)),
	CONSTRAINT "campaign_write_ups_failure_check" CHECK (("campaign_write_ups"."status" = 'failed') = ("campaign_write_ups"."failure" is not null)),
	CONSTRAINT "campaign_write_ups_suggestions_check" CHECK (jsonb_typeof("campaign_write_ups"."suggestions") = 'array' and jsonb_array_length("campaign_write_ups"."suggestions") <= 3),
	CONSTRAINT "campaign_write_ups_cites_check" CHECK (jsonb_typeof("campaign_write_ups"."cites") = 'array')
);
--> statement-breakpoint
ALTER TABLE "campaign_write_ups" ADD CONSTRAINT "campaign_write_ups_campaign_fk" FOREIGN KEY ("workspace_id","campaign_id") REFERENCES "public"."campaigns"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_write_ups" ADD CONSTRAINT "campaign_write_ups_item_fk" FOREIGN KEY ("workspace_id","item_id") REFERENCES "public"."items"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Forced RLS, same workspace policy as every Workspace table.
ALTER TABLE campaign_write_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_write_ups FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON campaign_write_ups
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Write it again updates the row; only the Workspace purge removes it.
REVOKE DELETE ON campaign_write_ups FROM direx_app;
