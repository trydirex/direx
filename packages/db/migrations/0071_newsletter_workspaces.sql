-- Lists the Workspaces whose weekly newsletter is on, for the job that makes each week's issue. Ids only.
CREATE FUNCTION system.newsletter_workspaces()
RETURNS TABLE (workspace_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY
    SELECT s.workspace_id FROM public.newsletter_settings s WHERE s.enabled;
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('newsletter_workspaces', found);
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.newsletter_workspaces() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.newsletter_workspaces() TO direx_app;
