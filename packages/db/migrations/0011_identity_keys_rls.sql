-- Forced RLS on identity_keys, same policy as the people tables.
ALTER TABLE identity_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE identity_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON identity_keys
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- A key value, once seen, stays: it is only a lock. UPDATE stays granted because
-- FOR UPDATE needs it.
REVOKE DELETE ON identity_keys FROM direx_app;
