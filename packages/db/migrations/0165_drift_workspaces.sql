-- Lists the live Workspaces with an agent proposal whose route is known, for the daily drift check. Ids only.
CREATE FUNCTION system.drift_workspaces()
RETURNS TABLE (workspace_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY
    SELECT DISTINCT p.workspace_id FROM public.agent_proposals p
    JOIN public.workspaces w ON w.id = p.workspace_id AND w.deleted_at IS NULL AND w.purging_at IS NULL
    WHERE p.route_hash IS NOT NULL
    ORDER BY p.workspace_id;
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('drift_workspaces', found);
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.drift_workspaces() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.drift_workspaces() TO direx_app;
