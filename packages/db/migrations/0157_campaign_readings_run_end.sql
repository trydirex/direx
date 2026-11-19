-- Count through 30 days after the run ends (UTC), shifting the approved plan end with its launch.
-- across Workspaces, for the sweep that counts their readings. Ids only.
CREATE OR REPLACE FUNCTION system.campaigns_to_count()
RETURNS TABLE (workspace_id uuid, campaign_id uuid, plan_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY
    SELECT c.workspace_id, c.id, c.plan_id FROM public.campaigns c
    JOIN public.workspaces w ON w.id = c.workspace_id AND w.deleted_at IS NULL
    JOIN public.marketing_plans p ON p.workspace_id = c.workspace_id AND p.id = c.plan_id
    JOIN public.marketing_plan_versions v ON v.workspace_id = p.workspace_id AND v.plan_id = p.id AND v.version = p.current_version
    WHERE (v.body->>'endsOn')::date
      + (COALESCE(c.anchor_on, (v.body->>'startsOn')::date) - (v.body->>'startsOn')::date)
      >= (now() AT TIME ZONE 'UTC')::date - 30;
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('campaigns_to_count', found);
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.campaigns_to_count() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.campaigns_to_count() TO direx_app;
