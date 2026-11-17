-- direx:no-transaction
DROP INDEX CONCURRENTLY IF EXISTS "model_calls_workspace_id_reservation_id_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "model_calls_workspace_id_reservation_id_idx" ON "model_calls" USING btree ("workspace_id","reservation_id");
