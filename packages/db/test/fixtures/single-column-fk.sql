-- Must fail the catalog check: a single-column FK between tenant tables.
CREATE TABLE fx_parent (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);
ALTER TABLE fx_parent ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_parent FORCE ROW LEVEL SECURITY;
CREATE TABLE fx_child (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, parent_id uuid REFERENCES fx_parent (id));
ALTER TABLE fx_child ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_child FORCE ROW LEVEL SECURITY;
