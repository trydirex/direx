-- Forced RLS on every tenant table. Outside withWorkspace the setting
-- is unset or '', so nullif makes the policy compare against NULL and match nothing.
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON notes
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE note_comments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE note_comments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON note_comments
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
