-- Forced RLS on approval keys, same workspace policy as the rest. A key is retired, never
-- deleted, because old approvals verify by it.
ALTER TABLE approval_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE approval_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON approval_keys
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE DELETE ON approval_keys FROM direx_app;
