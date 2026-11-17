-- Forced RLS on who chose which AI and on stored sign-ins, same workspace policy as the rest.
ALTER TABLE agent_model_choices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_model_choices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON agent_model_choices
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE model_cli_sign_ins ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE model_cli_sign_ins FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON model_cli_sign_ins
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
