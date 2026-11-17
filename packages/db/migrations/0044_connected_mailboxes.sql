-- Lists Gmail connections across Workspaces for the job that keeps their polls running. Ids only.
CREATE FUNCTION system.connected_mailboxes()
RETURNS TABLE (workspace_id uuid, credential_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY
    SELECT c.workspace_id, c.id FROM public.credentials c
    WHERE c.kind = 'oauth2' AND c.connection = 'google' AND c.status = 'active' AND c.deleted_at IS NULL;
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('connected_mailboxes', found);
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.connected_mailboxes() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.connected_mailboxes() TO direx_app;
