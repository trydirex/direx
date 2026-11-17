-- Forced RLS on the history of agent choices, same workspace policy as the rest. The history is append-only.
ALTER TABLE agent_model_choice_revisions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_model_choice_revisions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON agent_model_choice_revisions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON agent_model_choice_revisions FROM direx_app;
