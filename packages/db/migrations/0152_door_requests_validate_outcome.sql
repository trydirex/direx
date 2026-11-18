-- Validate after 0151 commits and releases its ACCESS EXCLUSIVE lock.
ALTER TABLE "door_requests" VALIDATE CONSTRAINT "door_requests_outcome_check";
