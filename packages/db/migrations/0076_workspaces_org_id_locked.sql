-- The app may rename or delete a Workspace, but never move it into another Organization:
-- org_id decides which Organization's rows a Workspace can reach. Postgres can't revoke one
-- column out of a table-wide grant, so the table-wide UPDATE goes and two columns come back.
-- Changing org_id is left to the transfer path, which does not exist yet.
REVOKE UPDATE ON workspaces FROM direx_app;
--> statement-breakpoint
GRANT UPDATE (name, deleted_at) ON workspaces TO direx_app;
