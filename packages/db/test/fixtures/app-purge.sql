-- Must fail the catalog check: the app could run part of the purge.
GRANT EXECUTE ON FUNCTION system.purge_workspace_batch(uuid, text, integer) TO direx_app;
