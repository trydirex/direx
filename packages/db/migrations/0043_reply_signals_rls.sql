-- Forced RLS on reply_signals, same workspace policy as the rest.
ALTER TABLE reply_signals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE reply_signals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON reply_signals
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- The evidence for an opt-out stays; only the text is cleared, by an update.
REVOKE DELETE ON reply_signals FROM direx_app;
