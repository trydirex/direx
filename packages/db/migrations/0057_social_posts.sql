CREATE TABLE "social_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"connection" text NOT NULL,
	"network_id" text NOT NULL,
	"credential_id" uuid,
	"account_name" text,
	"item_id" uuid NOT NULL,
	"action_id" uuid,
	"posted_url" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "social_posts_one_per_account" UNIQUE("workspace_id","campaign_id","step_key","connection","network_id")
);
--> statement-breakpoint
ALTER TABLE "items" DROP CONSTRAINT "items_state_check";--> statement-breakpoint
ALTER TABLE "campaign_steps" DROP CONSTRAINT "campaign_steps_type_check";--> statement-breakpoint
ALTER TABLE "campaign_steps" ALTER COLUMN "touch_class" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_step_fk" FOREIGN KEY ("workspace_id","campaign_id","step_key") REFERENCES "public"."campaign_steps"("workspace_id","campaign_id","step_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_item_fk" FOREIGN KEY ("workspace_id","item_id") REFERENCES "public"."items"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_action_fk" FOREIGN KEY ("workspace_id","action_id") REFERENCES "public"."actions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_state_check" CHECK ("items"."state" in ('draft', 'needs_approval', 'scheduled', 'applied', 'cancelled'));--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_touch_class_post_check" CHECK (("campaign_steps"."type" = 'post') = ("campaign_steps"."touch_class" is null));--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_type_check" CHECK ("campaign_steps"."type" in ('email', 'manual', 'post'));--> statement-breakpoint
-- Forced RLS on social_posts, same workspace policy as the rest. A post is history, so it is never deleted.
ALTER TABLE social_posts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE social_posts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON social_posts
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE DELETE ON social_posts FROM direx_app;
