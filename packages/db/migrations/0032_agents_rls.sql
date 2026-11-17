-- Forced RLS on agent runs, same workspace policy as the rest. A run is never deleted, and
-- what it read, did and changed is append-only, so a run can always be audited.
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON agent_runs
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE agent_run_parts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_run_parts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON agent_run_parts
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE agent_run_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_run_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON agent_run_events
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE agent_proposals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_proposals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON agent_proposals
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE agent_cancellations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_cancellations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON agent_cancellations
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE agent_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON agent_settings
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE agent_setting_revisions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_setting_revisions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON agent_setting_revisions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE DELETE ON agent_runs FROM direx_app;
--> statement-breakpoint
REVOKE DELETE ON agent_proposals FROM direx_app;
--> statement-breakpoint
REVOKE DELETE ON agent_settings FROM direx_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON agent_run_parts FROM direx_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON agent_run_events FROM direx_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON agent_cancellations FROM direx_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON agent_setting_revisions FROM direx_app;
