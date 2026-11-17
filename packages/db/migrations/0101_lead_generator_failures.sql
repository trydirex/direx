ALTER TABLE "prospect_handovers" DROP CONSTRAINT "prospect_handovers_status_check";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "prospect_handover_results" ADD COLUMN "basis" text;--> statement-breakpoint
ALTER TABLE "prospect_handover_results" ADD COLUMN "evidence" text;--> statement-breakpoint
ALTER TABLE "prospect_handovers" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "prospect_handovers" ADD CONSTRAINT "prospect_handovers_failure_check" CHECK (("prospect_handovers"."status" = 'failed') = ("prospect_handovers"."failure_reason" is not null));--> statement-breakpoint
ALTER TABLE "prospect_handovers" ADD CONSTRAINT "prospect_handovers_status_check" CHECK ("prospect_handovers"."status" in ('running', 'done', 'failed'));