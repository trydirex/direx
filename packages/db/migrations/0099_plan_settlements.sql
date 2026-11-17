CREATE TABLE "campaign_settlements" (
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"key" text NOT NULL,
	"work" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"claimed_until" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "campaign_settlements_pkey" PRIMARY KEY("workspace_id","campaign_id","key"),
	CONSTRAINT "campaign_settlements_attempts_check" CHECK ("campaign_settlements"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "campaign_settlements" ADD CONSTRAINT "campaign_settlements_campaign_fk" FOREIGN KEY ("workspace_id","campaign_id") REFERENCES "public"."campaigns"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Forced RLS, same workspace policy as the rest. A row is settled, never deleted.
ALTER TABLE campaign_settlements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE campaign_settlements FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON campaign_settlements
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE DELETE ON campaign_settlements FROM direx_app;
--> statement-breakpoint
-- Lists Campaigns with plan change work still owed and not held by a run, across Workspaces, for the sweep that finishes it. Ids only.
CREATE FUNCTION system.unsettled_campaigns()
RETURNS TABLE (workspace_id uuid, campaign_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY
    SELECT DISTINCT s.workspace_id, s.campaign_id FROM public.campaign_settlements s
    WHERE s.settled_at IS NULL AND (s.claimed_until IS NULL OR s.claimed_until < now());
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('unsettled_campaigns', found);
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.unsettled_campaigns() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.unsettled_campaigns() TO direx_app;
