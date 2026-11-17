-- Lists Workspaces whose active data key was wrapped by a root key other than the given one, for the
-- doctor: their credentials and approvals can't be read by this deployment. Ids only.
CREATE FUNCTION system.workspaces_keyed_by_other_root(root_key text)
RETURNS TABLE (workspace_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY
    SELECT k.workspace_id FROM public.workspace_keys k
    WHERE k.retired_at IS NULL AND k.root_key_id <> root_key
    ORDER BY k.workspace_id;
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('workspaces_keyed_by_other_root', found);
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.workspaces_keyed_by_other_root(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.workspaces_keyed_by_other_root(text) TO direx_app;
