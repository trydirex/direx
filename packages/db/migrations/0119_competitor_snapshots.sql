CREATE TABLE "competitor_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"competitor_id" uuid NOT NULL,
	"source" text NOT NULL,
	"before_snapshot_id" uuid NOT NULL,
	"after_snapshot_id" uuid NOT NULL,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "competitor_changes_source_check" CHECK ("competitor_changes"."source" in ('pricing', 'changelog', 'landing'))
);
--> statement-breakpoint
CREATE TABLE "competitor_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"competitor_id" uuid NOT NULL,
	"source" text NOT NULL,
	"url" text NOT NULL,
	"final_url" text,
	"week" date NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	"failure" text,
	"truncated" boolean DEFAULT false NOT NULL,
	"parts" jsonb,
	CONSTRAINT "competitor_snapshots_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "competitor_snapshots_week_key" UNIQUE("competitor_id","source","week"),
	CONSTRAINT "competitor_snapshots_source_check" CHECK ("competitor_snapshots"."source" in ('pricing', 'changelog', 'landing')),
	CONSTRAINT "competitor_snapshots_outcome_check" CHECK (("competitor_snapshots"."failure" is null) = ("competitor_snapshots"."parts" is not null))
);
--> statement-breakpoint
ALTER TABLE "competitor_changes" ADD CONSTRAINT "competitor_changes_competitor_fk" FOREIGN KEY ("workspace_id","competitor_id") REFERENCES "public"."competitors"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_changes" ADD CONSTRAINT "competitor_changes_before_fk" FOREIGN KEY ("workspace_id","before_snapshot_id") REFERENCES "public"."competitor_snapshots"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_changes" ADD CONSTRAINT "competitor_changes_after_fk" FOREIGN KEY ("workspace_id","after_snapshot_id") REFERENCES "public"."competitor_snapshots"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_snapshots" ADD CONSTRAINT "competitor_snapshots_competitor_fk" FOREIGN KEY ("workspace_id","competitor_id") REFERENCES "public"."competitors"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competitor_changes_recent_idx" ON "competitor_changes" USING btree ("workspace_id","competitor_id","created_at");--> statement-breakpoint
CREATE INDEX "competitor_snapshots_last_idx" ON "competitor_snapshots" USING btree ("workspace_id","competitor_id","source","read_at");--> statement-breakpoint
-- Forced RLS, same workspace policy as every Workspace table.
ALTER TABLE competitor_snapshots ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE competitor_snapshots FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON competitor_snapshots
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE competitor_changes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE competitor_changes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON competitor_changes
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Lists Workspaces with at least one competitor, for the weekly read. Ids only.
CREATE FUNCTION system.competitor_workspaces()
RETURNS TABLE (workspace_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY
    SELECT DISTINCT c.workspace_id FROM public.competitors c
    ORDER BY c.workspace_id;
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('competitor_workspaces', found);
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.competitor_workspaces() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.competitor_workspaces() TO direx_app;