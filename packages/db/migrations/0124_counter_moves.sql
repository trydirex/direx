ALTER TABLE "facts" DROP CONSTRAINT "facts_field_check";--> statement-breakpoint
ALTER TABLE "competitor_changes" ADD COLUMN "item_id" uuid;--> statement-breakpoint
ALTER TABLE "competitors" ADD COLUMN "comparison_url" text;--> statement-breakpoint
ALTER TABLE "competitor_changes" ADD CONSTRAINT "competitor_changes_item_fk" FOREIGN KEY ("workspace_id","item_id") REFERENCES "public"."items"("workspace_id","id") ON DELETE SET NULL ("item_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_field_check" CHECK ("facts"."field" in ('what_you_sell', 'who_buys', 'tone', 'price', 'claim', 'never_say', 'competitor'));--> statement-breakpoint
ALTER TABLE "competitor_changes" ADD CONSTRAINT "competitor_changes_item_check" CHECK ("competitor_changes"."item_id" is null or "competitor_changes"."label" is not distinct from 'answer');