-- Forced RLS on the people and reservation tables, same policy as the ledger tables.
ALTER TABLE people ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE people FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON people
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE person_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE person_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON person_keys
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE person_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE person_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON person_links
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE touch_reservations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE touch_reservations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON touch_reservations
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Records and merge decisions are kept: reservations point at records, and a rejected
-- link must stay rejected. A reservation never changes; its Action's state says whether
-- it still counts.
REVOKE DELETE ON people FROM direx_app;
--> statement-breakpoint
REVOKE DELETE ON person_links FROM direx_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON touch_reservations FROM direx_app;
