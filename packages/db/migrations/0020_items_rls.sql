-- Forced RLS on the items tables, same workspace policy as the rest. Items are never
-- deleted, Cancelled is the end of the road, and their events are append-only.
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON items
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE item_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE item_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON item_events
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE DELETE ON items FROM direx_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON item_events FROM direx_app;
