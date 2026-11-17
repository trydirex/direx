-- Forced RLS on the outreach tables, same workspace policy as the rest.
ALTER TABLE outreach_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE outreach_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON outreach_settings
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE suppressions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE suppressions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON suppressions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- An opt-out stands: the product can add one and never take it back.
REVOKE UPDATE, DELETE ON suppressions FROM direx_app;
--> statement-breakpoint
ALTER TABLE unsubscribe_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE unsubscribe_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON unsubscribe_tokens
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE person_eligibility ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE person_eligibility FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON person_eligibility
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- The sweep: Actions overdue by more than a minute, whose wake was lost or fired early. It returns
-- only ids and records that it looked. FORCE RLS applies to a non-superuser owner, so the migrating
-- role needs BYPASSRLS for this to see any Action.
CREATE TABLE system.system_audit (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  function_name text NOT NULL,
  rows_returned integer NOT NULL
);
--> statement-breakpoint
CREATE FUNCTION system.overdue_actions(max_rows integer)
RETURNS TABLE (workspace_id uuid, action_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY
    SELECT a.workspace_id, a.id FROM public.actions a
    WHERE (a.state = 'scheduled' AND a.due_at < now() - interval '1 minute')
       OR (a.state = 'claimed' AND a.updated_at < now() - interval '1 minute')
       OR (a.state = 'dispatching' AND a.dispatch_started_at < now() - interval '2 minutes')
       OR (a.state = 'held' AND a.next_attempt_at < now() - interval '1 minute')
       OR (a.state = 'needs_approval' AND a.approval_requested_at < now() - interval '14 days 1 minute')
    ORDER BY a.updated_at
    LIMIT max_rows;
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('overdue_actions', found);
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.overdue_actions(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA system TO direx_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.overdue_actions(integer) TO direx_app;
