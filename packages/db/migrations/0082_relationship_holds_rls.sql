-- Forced RLS on the relationship-hold tables, same workspace policy as the rest.
ALTER TABLE relationship_holds ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE relationship_holds FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON relationship_holds
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE correspondents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE correspondents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON correspondents
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE hold_releases ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hold_releases FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON hold_releases
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE hold_hooks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hold_hooks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON hold_hooks
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- A hold is ended, never removed, so the 90-day wait after it can't be erased.
REVOKE DELETE ON relationship_holds FROM direx_app;
--> statement-breakpoint
-- Releases are the record of who let a guessed hold go.
REVOKE UPDATE, DELETE ON hold_releases FROM direx_app;
--> statement-breakpoint
REVOKE DELETE ON hold_hooks FROM direx_app;
