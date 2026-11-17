-- Forced RLS on the credential vault tables, same workspace policy as the rest. Nothing
-- here is ever deleted by the app: a data key is retired, a credential is soft-deleted
-- with its ciphertext nulled, and access events are append-only.
ALTER TABLE workspace_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON workspace_keys
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE credentials FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON credentials
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE credential_access_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE credential_access_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON credential_access_events
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE DELETE ON workspace_keys FROM direx_app;
--> statement-breakpoint
REVOKE DELETE ON credentials FROM direx_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON credential_access_events FROM direx_app;
