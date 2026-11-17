ALTER TABLE "agent_proposals" ADD COLUMN "body" jsonb;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD COLUMN "target_kind" text;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD COLUMN "target_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD COLUMN "target_step_key" text;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD COLUMN "offer" text;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD COLUMN "offer_by" uuid;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD COLUMN "offer_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_offer_by_user_id_fk" FOREIGN KEY ("offer_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_proposals_one_open_offer" ON "agent_proposals" USING btree ("workspace_id","target_kind",coalesce("target_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("target_step_key", '')) WHERE "agent_proposals"."offer" = 'open';--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_offer_check" CHECK ("agent_proposals"."offer" is null or ("agent_proposals"."offer" in ('open', 'used', 'dismissed', 'replaced') and "agent_proposals"."body" is not null and "agent_proposals"."target_kind" in ('strategy', 'plan', 'step')));