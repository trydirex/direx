-- Forced RLS on business context, same workspace policy as the rest. A fact is retired,
-- never deleted, and a version never changes, so old approvals can show what they cited.
ALTER TABLE facts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE facts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON facts
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE fact_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE fact_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON fact_versions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE DELETE ON facts FROM direx_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON fact_versions FROM direx_app;
