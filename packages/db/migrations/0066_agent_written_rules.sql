ALTER TABLE "standing_rule_revisions" ALTER COLUMN "template_revision" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "standing_rules" ALTER COLUMN "template_revision" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "standing_rules" ALTER COLUMN "daily_cap" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "producer_digest" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "outside_content_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "outside_content_set_by" uuid;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "outside_content_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "standing_rule_revisions" ADD COLUMN "producer" jsonb;--> statement-breakpoint
ALTER TABLE "standing_rules" ADD COLUMN "mode" text DEFAULT 'template' NOT NULL;--> statement-breakpoint
ALTER TABLE "standing_rules" ADD COLUMN "producer" jsonb;--> statement-breakpoint
ALTER TABLE "standing_rules" ADD COLUMN "allowed_facts" jsonb;--> statement-breakpoint
ALTER TABLE "standing_rules" ADD COLUMN "outside_content" boolean;--> statement-breakpoint
ALTER TABLE "standing_rules" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "standing_rules" ADD COLUMN "wording_version" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_outside_content_set_by_user_id_fk" FOREIGN KEY ("outside_content_set_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_rules" ADD CONSTRAINT "standing_rules_mode_check" CHECK ("standing_rules"."mode" in ('template', 'agent_written'));--> statement-breakpoint
ALTER TABLE "standing_rules" ADD CONSTRAINT "standing_rules_template_mode_check" CHECK ("standing_rules"."mode" <> 'template' or ("standing_rules"."template_revision" is not null and "standing_rules"."daily_cap" is not null and "standing_rules"."producer" is null));--> statement-breakpoint
ALTER TABLE "standing_rules" ADD CONSTRAINT "standing_rules_agent_mode_check" CHECK ("standing_rules"."mode" <> 'agent_written' or ("standing_rules"."template_revision" is null and "standing_rules"."daily_cap" is null and "standing_rules"."producer" is not null and "standing_rules"."allowed_facts" is not null and "standing_rules"."outside_content" = true and "standing_rules"."language" is not null and "standing_rules"."wording_version" is not null and "standing_rules"."drafting_agent" is not null));