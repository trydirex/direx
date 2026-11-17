CREATE TABLE "workspace_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"storage_key" text NOT NULL,
	"ready_at" timestamp with time zone,
	"bytes" bigint,
	"expires_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	CONSTRAINT "workspace_exports_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "workspace_exports_storage_key_check" CHECK ("workspace_exports"."storage_key" = "workspace_exports"."workspace_id"::text || '/' || "workspace_exports"."id"::text),
	CONSTRAINT "workspace_exports_ready_check" CHECK (("workspace_exports"."ready_at" is null or "workspace_exports"."failed_at" is null) and ("workspace_exports"."ready_at" is null) = ("workspace_exports"."bytes" is null) and ("workspace_exports"."ready_at" is null) = ("workspace_exports"."expires_at" is null)),
	CONSTRAINT "workspace_exports_expiry_check" CHECK ("workspace_exports"."expires_at" is null or "workspace_exports"."expires_at" = "workspace_exports"."ready_at" + interval '24 hours')
);
--> statement-breakpoint
ALTER TABLE "workspace_exports" ADD CONSTRAINT "workspace_exports_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_exports" ADD CONSTRAINT "workspace_exports_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_exports_workspace_id_requested_at_idx" ON "workspace_exports" USING btree ("workspace_id","requested_at");--> statement-breakpoint
ALTER TABLE workspace_exports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_exports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON workspace_exports
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- The record of an export stays: the app may only mark it ready, failed or removed.
REVOKE UPDATE, DELETE ON workspace_exports FROM direx_app;
--> statement-breakpoint
GRANT UPDATE (ready_at, bytes, expires_at, failed_at, removed_at) ON workspace_exports TO direx_app;
--> statement-breakpoint
-- The exports whose ZIP should go: past their 24 hours, or failed. Deleted Workspaces included, since
-- their exports expire too. Returns ids and the key built from them only.
CREATE FUNCTION system.export_sweep_due()
RETURNS TABLE (workspace_id uuid, id uuid, storage_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY SELECT e.workspace_id, e.id, e.storage_key FROM public.workspace_exports e
    WHERE e.removed_at IS NULL AND (e.expires_at < now() OR e.failed_at IS NOT NULL);
  GET DIAGNOSTICS found = ROW_COUNT;
  INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('export_sweep_due', found);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.export_sweep_due() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.export_sweep_due() TO direx_app;
