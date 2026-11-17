-- Forced RLS on the identity tables. Tenant tables use the same workspace policy as the
-- rest. Two SELECT-only policies read app.user_id, which only withUser sets, in a
-- read-only transaction (DX-R-0003-010): a user's own memberships, and the Workspaces
-- those name.
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON workspaces
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY member_read ON workspaces FOR SELECT
  USING (workspace_id IN (SELECT m.workspace_id FROM workspace_members m));
--> statement-breakpoint
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON workspace_members
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY own_read ON workspace_members FOR SELECT
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE workspace_invites ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_invites FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON workspace_invites
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE workspace_audit ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_audit FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON workspace_audit
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- The audit is append-only.
REVOKE UPDATE, DELETE ON workspace_audit FROM direx_app;
--> statement-breakpoint
-- Anyone may create an Organization; it holds no tenant data. It is readable only
-- through a Workspace the reader can already see.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY create_any ON organizations FOR INSERT WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY via_workspace ON organizations FOR SELECT
  USING (id IN (SELECT w.org_id FROM workspaces w));
