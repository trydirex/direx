CREATE TABLE "review_feeds" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"weekdays" integer[] NOT NULL,
	"start_minute" integer NOT NULL,
	"length_minutes" integer NOT NULL,
	"time_zone" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"fetch_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "review_feeds_pkey" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "review_feeds_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "review_feeds_token_hash_check" CHECK ("review_feeds"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "review_feeds_weekdays_check" CHECK (cardinality("review_feeds"."weekdays") between 1 and 7 and "review_feeds"."weekdays" <@ array[1, 2, 3, 4, 5, 6, 7]),
	CONSTRAINT "review_feeds_start_check" CHECK ("review_feeds"."start_minute" between 0 and 1439),
	CONSTRAINT "review_feeds_length_check" CHECK ("review_feeds"."length_minutes" in (15, 30, 60)),
	CONSTRAINT "review_feeds_time_zone_check" CHECK ("review_feeds"."time_zone" <> '')
);
--> statement-breakpoint
ALTER TABLE "review_feeds" ADD CONSTRAINT "review_feeds_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."workspace_members"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Forced RLS, same workspace policy as every Workspace table.
ALTER TABLE review_feeds ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE review_feeds FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON review_feeds
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
