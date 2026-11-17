ALTER TABLE "competitor_changes" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "competitor_changes" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "competitor_changes" ADD COLUMN "same_as_change_id" uuid;--> statement-breakpoint
ALTER TABLE "competitor_changes" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "competitor_changes" ADD COLUMN "labelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "competitor_changes" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "competitor_changes" ADD CONSTRAINT "competitor_changes_competitor_id_key" UNIQUE("workspace_id","competitor_id","id");--> statement-breakpoint
ALTER TABLE "competitor_changes" ADD CONSTRAINT "competitor_changes_same_as_fk" FOREIGN KEY ("workspace_id","competitor_id","same_as_change_id") REFERENCES "public"."competitor_changes"("workspace_id","competitor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_changes" ADD CONSTRAINT "competitor_changes_label_check" CHECK ("competitor_changes"."label" is null or "competitor_changes"."label" in ('answer', 'noise'));--> statement-breakpoint
ALTER TABLE "competitor_changes" ADD CONSTRAINT "competitor_changes_kind_check" CHECK (("competitor_changes"."kind" is null) = ("competitor_changes"."label" is distinct from 'answer') and ("competitor_changes"."kind" is null or "competitor_changes"."kind" in ('fact_update', 'comparison_page', 'post', 'ranking_brief')));--> statement-breakpoint
ALTER TABLE "competitor_changes" ADD CONSTRAINT "competitor_changes_same_as_check" CHECK ("competitor_changes"."same_as_change_id" is null or ("competitor_changes"."label" = 'answer' and "competitor_changes"."same_as_change_id" <> "competitor_changes"."id"));--> statement-breakpoint
ALTER TABLE "competitor_changes" ADD CONSTRAINT "competitor_changes_labelled_check" CHECK (("competitor_changes"."label" is null) = ("competitor_changes"."labelled_at" is null) and ("competitor_changes"."label" is null) = ("competitor_changes"."reason" is null));--> statement-breakpoint
ALTER TABLE "competitor_changes" ADD CONSTRAINT "competitor_changes_reason_check" CHECK ("competitor_changes"."reason" is null or char_length("competitor_changes"."reason") between 1 and 200);