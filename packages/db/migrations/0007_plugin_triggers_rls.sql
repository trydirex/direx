-- Forced RLS on the plugin trigger tables, same policy as the ledger tables.
ALTER TABLE trigger_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trigger_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON trigger_events
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE trigger_cursors ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trigger_cursors FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON trigger_cursors
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Seen event ids are append-only, and a cursor is moved, never removed.
REVOKE UPDATE, DELETE ON trigger_events FROM direx_app;
--> statement-breakpoint
REVOKE DELETE ON trigger_cursors FROM direx_app;
