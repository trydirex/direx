-- Validate after 0165 commits and releases its ACCESS EXCLUSIVE lock.
ALTER TABLE "agent_run_events" VALIDATE CONSTRAINT "agent_run_events_kind_check";
