-- Must fail the catalog check: a function in schema system that is not SECURITY DEFINER.
CREATE FUNCTION system.fx_invoker() RETURNS int LANGUAGE sql AS 'SELECT 1';
