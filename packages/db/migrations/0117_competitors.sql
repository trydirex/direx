CREATE TABLE "competitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"pricing_url" text,
	"changelog_url" text,
	"landing_url" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "competitors_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "competitors_one_url_check" CHECK (coalesce("competitors"."pricing_url", "competitors"."changelog_url", "competitors"."landing_url") is not null),
	CONSTRAINT "competitors_name_check" CHECK (char_length("competitors"."name") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "competitors_name_key" ON "competitors" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
-- Forced RLS, same workspace policy as every Workspace table.
ALTER TABLE competitors ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE competitors FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON competitors
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);