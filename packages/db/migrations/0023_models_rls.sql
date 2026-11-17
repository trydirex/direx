-- Forced RLS on budget reservations and the model tables, same workspace policy as the
-- rest. Reservations and calls are never deleted, and revisions and incidents never change.
ALTER TABLE budget_reservations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE budget_reservations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON budget_reservations
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE model_calls ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE model_calls FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON model_calls
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE model_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE model_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON model_connections
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE model_settings_revisions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE model_settings_revisions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON model_settings_revisions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE model_budget_incidents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE model_budget_incidents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON model_budget_incidents
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE DELETE ON budget_reservations FROM direx_app;
--> statement-breakpoint
REVOKE DELETE ON model_calls FROM direx_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON model_settings_revisions FROM direx_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON model_budget_incidents FROM direx_app;
