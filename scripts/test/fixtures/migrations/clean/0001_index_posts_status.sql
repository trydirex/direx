-- direx:no-transaction
-- posts is large: indexes are built concurrently and backfills are batched.
CREATE INDEX CONCURRENTLY "posts_status_idx" ON "posts" USING btree ("status");
--> statement-breakpoint
UPDATE "posts" SET "status" = 'draft' WHERE "status" = '';
