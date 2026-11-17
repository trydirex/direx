ALTER TABLE "campaign_steps" DROP CONSTRAINT "campaign_steps_type_check";--> statement-breakpoint
ALTER TABLE "campaign_steps" DROP CONSTRAINT "campaign_steps_touch_class_post_check";--> statement-breakpoint
ALTER TABLE "seo_briefs" DROP CONSTRAINT "seo_briefs_selector_check";--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD COLUMN "seo_setup" jsonb;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD COLUMN "brief_run_id" uuid;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_seo_setup_check" CHECK (("campaign_steps"."seo_setup" is null and "campaign_steps"."brief_run_id" is null) or "campaign_steps"."type" = 'seo_brief');--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_type_check" CHECK ("campaign_steps"."type" in ('email', 'manual', 'post', 'dm', 'clips', 'seo_brief'));--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_touch_class_post_check" CHECK (("campaign_steps"."type" in ('post', 'clips', 'seo_brief')) = ("campaign_steps"."touch_class" is null));--> statement-breakpoint
ALTER TABLE "seo_briefs" ADD CONSTRAINT "seo_briefs_selector_check" CHECK ("seo_briefs"."selector" in ('near_page_one', 'slipping', 'competing', 'step'));