-- Must fail the catalog check: the app could insert a Workspace already deleted, early for the purge.
DROP TRIGGER workspaces_insert_live ON workspaces;
