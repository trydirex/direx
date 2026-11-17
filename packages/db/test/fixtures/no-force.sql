-- Must fail the catalog check: RLS on, FORCE off.
CREATE TABLE fx_no_force (workspace_id uuid NOT NULL);
ALTER TABLE fx_no_force ENABLE ROW LEVEL SECURITY;
