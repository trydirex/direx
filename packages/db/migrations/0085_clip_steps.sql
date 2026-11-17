ALTER TABLE "social_posts" DROP CONSTRAINT "social_posts_one_per_account";--> statement-breakpoint
ALTER TABLE "campaign_steps" DROP CONSTRAINT "campaign_steps_type_check";--> statement-breakpoint
ALTER TABLE "campaign_steps" DROP CONSTRAINT "campaign_steps_touch_class_post_check";--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD COLUMN "clip_setup" jsonb;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD COLUMN "clip_run_id" uuid;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "clip_id" uuid;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_workspace_id_id_key" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_clip_fk" FOREIGN KEY ("workspace_id","clip_id") REFERENCES "public"."clips"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_one_per_account" UNIQUE NULLS NOT DISTINCT("workspace_id","campaign_id","step_key","connection","network_id","clip_id");--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_clip_setup_check" CHECK (("campaign_steps"."clip_setup" is null and "campaign_steps"."clip_run_id" is null) or "campaign_steps"."type" = 'clips');--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_type_check" CHECK ("campaign_steps"."type" in ('email', 'manual', 'post', 'dm', 'clips'));--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_touch_class_post_check" CHECK (("campaign_steps"."type" in ('post', 'clips')) = ("campaign_steps"."touch_class" is null));