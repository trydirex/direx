-- The daily media sweep, across Workspaces. Sources older than source_days are marked deleted, then
-- every deleted file whose bytes are still stored is listed. The app removes the bytes and marks each
-- row inside its own Workspace, so a file the store can't remove waits for the next run.
CREATE FUNCTION system.media_sweep_due(at timestamptz, source_days integer)
RETURNS TABLE (workspace_id uuid, id uuid, storage_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  aged integer;
  due integer;
BEGIN
  UPDATE public.media AS m SET deleted_at = at
    WHERE m.kind = 'source' AND m.deleted_at IS NULL AND m.created_at <= at - make_interval(days => source_days);
  GET DIAGNOSTICS aged = ROW_COUNT;
  RETURN QUERY
    SELECT m.workspace_id, m.id, m.storage_key FROM public.media AS m
    WHERE m.deleted_at IS NOT NULL AND m.bytes_removed_at IS NULL
    ORDER BY m.deleted_at;
  GET DIAGNOSTICS due = ROW_COUNT;
  IF aged + due > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('media_sweep_due', due);
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.media_sweep_due(timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.media_sweep_due(timestamptz, integer) TO direx_app;
