-- Must fail the catalog check: the app could backdate a Workspace's deletion.
GRANT UPDATE (deleted_at) ON workspaces TO direx_app;
