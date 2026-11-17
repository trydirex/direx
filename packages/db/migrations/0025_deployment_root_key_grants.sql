-- Recorded once. Replacing the root key is a deliberate operator step, never the app's.
REVOKE UPDATE, DELETE ON deployment_root_key FROM direx_app;
