-- Reply text waiting on a person is held for 30 days at most. The row and the hold stay.
CREATE FUNCTION system.clear_old_reply_text()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  UPDATE public.reply_signals SET text = NULL
    WHERE text IS NOT NULL AND received_at < now() - interval '30 days';
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('clear_old_reply_text', found);
  END IF;
  RETURN found;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.clear_old_reply_text() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.clear_old_reply_text() TO direx_app;
