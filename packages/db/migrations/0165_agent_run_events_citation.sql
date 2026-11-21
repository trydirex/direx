ALTER TABLE "agent_run_events" DROP CONSTRAINT "agent_run_events_kind_check";--> statement-breakpoint
-- A citation a sink dropped is recorded as its own event. agent_run_events is on the large list, so the
-- wider check is added NOT VALID and 0166 validates it after this file releases its table lock.
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_kind_check" CHECK ("agent_run_events"."kind" in ('model_call', 'tool_call', 'proposal', 'rejection', 'citation')) NOT VALID;
