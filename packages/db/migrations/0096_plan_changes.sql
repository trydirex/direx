CREATE TABLE "campaign_plan_changes" (
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"from_version" integer NOT NULL,
	"to_version" integer NOT NULL,
	"kinds" text[] NOT NULL,
	"suggested_template" jsonb,
	"item_id" uuid NOT NULL,
	"decided" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "campaign_plan_changes_pkey" PRIMARY KEY("workspace_id","campaign_id","step_key"),
	CONSTRAINT "campaign_plan_changes_kinds_check" CHECK (cardinality("campaign_plan_changes"."kinds") > 0 and "campaign_plan_changes"."kinds" <@ array['text', 'channel', 'removed']),
	CONSTRAINT "campaign_plan_changes_suggested_check" CHECK (("campaign_plan_changes"."suggested_template" is not null) = ('text' = any("campaign_plan_changes"."kinds"))),
	CONSTRAINT "campaign_plan_changes_decided_check" CHECK (num_nulls("campaign_plan_changes"."decided", "campaign_plan_changes"."decided_by", "campaign_plan_changes"."decided_at") in (0, 3) and "campaign_plan_changes"."decided" in ('keep', 'use_new_text', 'cancel'))
);
--> statement-breakpoint
ALTER TABLE "campaign_plan_changes" ADD CONSTRAINT "campaign_plan_changes_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_plan_changes" ADD CONSTRAINT "campaign_plan_changes_campaign_fk" FOREIGN KEY ("workspace_id","campaign_id") REFERENCES "public"."campaigns"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_plan_changes" ADD CONSTRAINT "campaign_plan_changes_item_fk" FOREIGN KEY ("workspace_id","item_id") REFERENCES "public"."items"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Forced RLS, same workspace policy as the rest. A row is replaced or decided, never deleted.
ALTER TABLE campaign_plan_changes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE campaign_plan_changes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON campaign_plan_changes
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE DELETE ON campaign_plan_changes FROM direx_app;
