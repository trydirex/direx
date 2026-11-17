-- Must fail the catalog check: a workspace_id table with RLS off.
CREATE TABLE fx_rls_off (workspace_id uuid NOT NULL);
