CREATE TABLE "doc_rows" (
	"workspace_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"item_id" uuid NOT NULL,
	"imported_revision" integer NOT NULL,
	"edited_at" timestamp with time zone,
	"flag" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "doc_rows_pkey" PRIMARY KEY("workspace_id","source_id","external_id"),
	CONSTRAINT "doc_rows_flag_check" CHECK ("doc_rows"."flag" is null or "doc_rows"."flag" in ('changed_in_source'))
);
--> statement-breakpoint
CREATE TABLE "doc_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"set_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"checked_at" timestamp with time zone,
	CONSTRAINT "doc_sources_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "doc_sources_one_per_external" UNIQUE("workspace_id","external_id"),
	CONSTRAINT "doc_sources_external_check" CHECK ("doc_sources"."external_id" <> '' and char_length("doc_sources"."external_id") <= 200)
);
--> statement-breakpoint
ALTER TABLE "doc_rows" ADD CONSTRAINT "doc_rows_source_fk" FOREIGN KEY ("workspace_id","source_id") REFERENCES "public"."doc_sources"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_rows" ADD CONSTRAINT "doc_rows_item_fk" FOREIGN KEY ("workspace_id","item_id") REFERENCES "public"."items"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_sources" ADD CONSTRAINT "doc_sources_set_by_user_id_fk" FOREIGN KEY ("set_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_sources" ADD CONSTRAINT "doc_sources_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Forced RLS, same workspace policy as every Workspace table. Sources and rows are kept, never deleted.
ALTER TABLE doc_sources ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE doc_sources FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON doc_sources
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE doc_rows ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE doc_rows FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON doc_rows
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE DELETE ON doc_sources, doc_rows FROM direx_app;
