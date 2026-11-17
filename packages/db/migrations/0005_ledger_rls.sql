-- Forced RLS on the ledger tables, same policy as the example tables.
ALTER TABLE actions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE actions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON actions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE approvals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON approvals
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE action_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE action_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON action_events
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- History is never rewritten: no app deletes on actions or approvals, events are
-- append-only, and an approval may only be voided.
REVOKE DELETE ON actions FROM direx_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON approvals FROM direx_app;
--> statement-breakpoint
GRANT UPDATE (voided_at) ON approvals TO direx_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON action_events FROM direx_app;
