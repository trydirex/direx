CREATE TABLE "campaign_dms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"person_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"profile_url" text NOT NULL,
	"text" text NOT NULL,
	"template_revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"copied_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"sent_by" uuid,
	CONSTRAINT "campaign_dms_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "campaign_dms_person_key" UNIQUE("workspace_id","campaign_id","step_key","person_id"),
	CONSTRAINT "campaign_dms_channel_check" CHECK ("campaign_dms"."channel" in ('linkedin', 'x')),
	CONSTRAINT "campaign_dms_sent_check" CHECK (("campaign_dms"."sent_at" is null) = ("campaign_dms"."sent_by" is null))
);
--> statement-breakpoint
ALTER TABLE "person_keys" DROP CONSTRAINT "person_keys_kind_check";--> statement-breakpoint
ALTER TABLE "campaign_steps" DROP CONSTRAINT "campaign_steps_type_check";--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD COLUMN "dm_channel" text;--> statement-breakpoint
ALTER TABLE "campaign_dms" ADD CONSTRAINT "campaign_dms_sent_by_user_id_fk" FOREIGN KEY ("sent_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_dms" ADD CONSTRAINT "campaign_dms_person_fk" FOREIGN KEY ("workspace_id","campaign_id","person_id") REFERENCES "public"."campaign_people"("workspace_id","campaign_id","person_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_dms" ADD CONSTRAINT "campaign_dms_step_fk" FOREIGN KEY ("workspace_id","campaign_id","step_key") REFERENCES "public"."campaign_steps"("workspace_id","campaign_id","step_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_keys" ADD CONSTRAINT "person_keys_kind_check" CHECK ("person_keys"."kind" in ('email', 'phone', 'linkedin', 'x', 'hubspot', 'shopify'));--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_dm_channel_check" CHECK (("campaign_steps"."type" = 'dm') = ("campaign_steps"."dm_channel" is not null) and ("campaign_steps"."dm_channel" is null or "campaign_steps"."dm_channel" in ('linkedin', 'x')));--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_type_check" CHECK ("campaign_steps"."type" in ('email', 'manual', 'post', 'dm'));--> statement-breakpoint
-- Forced RLS, same workspace policy as every Workspace table.
ALTER TABLE campaign_dms ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE campaign_dms FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON campaign_dms
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- A drafted DM stays: whether it was copied and sent is the record the pilot measures.
REVOKE DELETE ON campaign_dms FROM direx_app;
