ALTER TABLE "review_decisions" DROP CONSTRAINT "review_decisions_decision_check";--> statement-breakpoint
ALTER TABLE "review_decisions" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD COLUMN "reason_note" text;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_reason_check" CHECK ("review_decisions"."reason" in ('salesy', 'long', 'facts', 'voice', 'audience', 'great'));--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_reason_note_check" CHECK (char_length("review_decisions"."reason_note") <= 300);--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_decision_check" CHECK ("review_decisions"."decision" in ('approve', 'edit_approve', 'reject', 'rewrite'));