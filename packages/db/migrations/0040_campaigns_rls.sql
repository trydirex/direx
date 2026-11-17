-- Forced RLS on campaigns, same workspace policy as the rest. Nothing in a campaign is deleted, and
-- the link from a step and Person to an Action never changes.
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON campaigns
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE campaign_steps ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE campaign_steps FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON campaign_steps
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE campaign_people ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE campaign_people FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON campaign_people
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE campaign_actions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE campaign_actions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON campaign_actions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE DELETE ON campaigns, campaign_steps, campaign_people, campaign_actions FROM direx_app;
--> statement-breakpoint
REVOKE UPDATE ON campaign_actions FROM direx_app;
