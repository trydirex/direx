-- Forced RLS on the newsletter tables, same workspace policy as every Workspace table.
ALTER TABLE newsletter_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE newsletter_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON newsletter_settings
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE newsletter_issues ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE newsletter_issues FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON newsletter_issues
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- An issue is a record of what went out: the product updates its stats and never removes it.
REVOKE DELETE ON newsletter_issues FROM direx_app;
