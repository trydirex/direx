CREATE TABLE "competitor_finds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"site" text,
	"terms" text[],
	"confirmed_micros" bigint,
	"confirmed_by" uuid,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "competitor_finds_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "competitor_finds_kind_check" CHECK (("competitor_finds"."kind" = 'own_site' and "competitor_finds"."site" is not null and "competitor_finds"."terms" is null and "competitor_finds"."confirmed_micros" is null and "competitor_finds"."confirmed_by" is null)
        or ("competitor_finds"."kind" = 'search' and "competitor_finds"."site" is null and "competitor_finds"."terms" is not null and "competitor_finds"."confirmed_micros" >= 0 and "competitor_finds"."confirmed_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "competitor_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"find_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"site" text,
	"comparison_url" text,
	"found_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"closed_as" text,
	CONSTRAINT "competitor_proposals_name_check" CHECK (char_length("competitor_proposals"."name") between 1 and 100 and "competitor_proposals"."name_key" ~ '^[a-z0-9]{1,100}$'),
	CONSTRAINT "competitor_proposals_url_check" CHECK (char_length(coalesce("competitor_proposals"."site", '')) <= 2000 and char_length(coalesce("competitor_proposals"."comparison_url", '')) <= 2000),
	CONSTRAINT "competitor_proposals_closed_check" CHECK (("competitor_proposals"."closed_at" is null and "competitor_proposals"."closed_by" is null and "competitor_proposals"."closed_as" is null) or ("competitor_proposals"."closed_at" is not null and "competitor_proposals"."closed_by" is not null and "competitor_proposals"."closed_as" in ('added', 'dismissed')))
);
--> statement-breakpoint
ALTER TABLE "competitor_finds" ADD CONSTRAINT "competitor_finds_confirmed_by_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_finds" ADD CONSTRAINT "competitor_finds_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_proposals" ADD CONSTRAINT "competitor_proposals_closed_by_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_proposals" ADD CONSTRAINT "competitor_proposals_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_proposals" ADD CONSTRAINT "competitor_proposals_find_fk" FOREIGN KEY ("workspace_id","find_id") REFERENCES "public"."competitor_finds"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_proposals_name_key" ON "competitor_proposals" USING btree ("workspace_id","name_key");--> statement-breakpoint
-- Forced RLS, same workspace policy as every Workspace table.
ALTER TABLE competitor_finds ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE competitor_finds FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON competitor_finds
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE competitor_proposals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE competitor_proposals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON competitor_proposals
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- A find is a record, kept as made. A proposal is only ever closed, never edited or deleted.
REVOKE UPDATE, DELETE ON competitor_finds FROM direx_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON competitor_proposals FROM direx_app;
--> statement-breakpoint
GRANT UPDATE (closed_at, closed_by, closed_as) ON competitor_proposals TO direx_app;
