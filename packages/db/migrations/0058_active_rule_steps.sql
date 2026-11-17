-- Lists the steps with an active rule across Workspaces, for the daily sweep over emails a cap left waiting. Ids only.
CREATE FUNCTION system.active_rule_steps()
RETURNS TABLE (workspace_id uuid, campaign_id uuid, step_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY
    SELECT DISTINCT r.workspace_id, r.campaign_id, r.step_key FROM public.standing_rules r
    WHERE r.status = 'active' AND r.expires_at > now();
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('active_rule_steps', found);
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.active_rule_steps() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.active_rule_steps() TO direx_app;
