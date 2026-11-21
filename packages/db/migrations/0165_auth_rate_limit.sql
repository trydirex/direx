CREATE TABLE "auth"."rate_limit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE INDEX "rate_limit_last_request_idx" ON "auth"."rate_limit" USING btree ("last_request");--> statement-breakpoint
-- Better Auth's rate limit counters: an auth table like the rest, no workspace_id and no RLS
-- (DX-R-0003-011), reached by the app role through authDb only.
GRANT SELECT, INSERT, UPDATE, DELETE ON "auth"."rate_limit" TO direx_app;
