CREATE TABLE "seo_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"page_url" text NOT NULL,
	"query" text NOT NULL,
	"selector" text NOT NULL,
	"numbers" jsonb NOT NULL,
	"brief" jsonb NOT NULL,
	"page_text" text NOT NULL,
	"page_read_at" timestamp with time zone NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seo_briefs_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "seo_briefs_item_key" UNIQUE("workspace_id","item_id"),
	CONSTRAINT "seo_briefs_selector_check" CHECK ("seo_briefs"."selector" in ('near_page_one', 'slipping', 'competing')),
	CONSTRAINT "seo_briefs_page_text_check" CHECK (octet_length("seo_briefs"."page_text") <= 204800)
);
--> statement-breakpoint
ALTER TABLE "seo_briefs" ADD CONSTRAINT "seo_briefs_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_briefs" ADD CONSTRAINT "seo_briefs_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_briefs" ADD CONSTRAINT "seo_briefs_item_fk" FOREIGN KEY ("workspace_id","item_id") REFERENCES "public"."items"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "seo_briefs_page_idx" ON "seo_briefs" USING btree ("workspace_id","page_url","approved_at");--> statement-breakpoint
-- Forced RLS, same workspace policy as every Workspace table.
ALTER TABLE seo_briefs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE seo_briefs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON seo_briefs
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- A brief is recorded once, when a person approves it, and never edited or removed.
REVOKE UPDATE, DELETE ON seo_briefs FROM direx_app;
