-- Lists Campaigns whose launch follows a step, in Campaigns that aren't paused, across Workspaces, for the daily job that moves a launch once that step's post is live. Ids only.
CREATE FUNCTION system.anchored_campaigns()
RETURNS TABLE (workspace_id uuid, campaign_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY
    SELECT c.workspace_id, c.id FROM public.campaigns c
    WHERE c.anchor_step_key IS NOT NULL AND c.paused_at IS NULL;
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('anchored_campaigns', found);
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.anchored_campaigns() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.anchored_campaigns() TO direx_app;
