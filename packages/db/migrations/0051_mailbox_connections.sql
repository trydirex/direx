-- Lists mailboxes on the given connections, whichever provider they use, for the job that keeps
-- their polls running. Ids and connection names only. Replaces the Gmail-only version.
DROP FUNCTION system.connected_mailboxes();
--> statement-breakpoint
CREATE FUNCTION system.connected_mailboxes(connections text[])
RETURNS TABLE (workspace_id uuid, credential_id uuid, connection text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY
    SELECT c.workspace_id, c.id, c.connection FROM public.credentials c
    WHERE c.connection = ANY (connections) AND c.status = 'active' AND c.deleted_at IS NULL;
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('connected_mailboxes', found);
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.connected_mailboxes(text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.connected_mailboxes(text[]) TO direx_app;
