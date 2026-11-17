-- The retention sweeps (ADR 0030 rule 002): one definer per operational table, deleting at most
-- `batch` rows its window (packages/db/src/retention.ts) has passed, and recording what it removed.
-- The app calls each until a batch comes back short. A deleted competitor snapshot takes the
-- Changes that name it with it (ON DELETE CASCADE).
CREATE FUNCTION system.sweep_trigger_events(batch integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  IF batch IS NULL OR batch NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'system.sweep_trigger_events: batch must be 1 to 10000';
  END IF;
  DELETE FROM public.trigger_events WHERE ctid = ANY (ARRAY(
    SELECT ctid FROM public.trigger_events WHERE received_at < now() - interval '90 days' LIMIT batch));
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('sweep_trigger_events', found);
  END IF;
  RETURN found;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.sweep_trigger_events(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.sweep_trigger_events(integer) TO direx_app;
--> statement-breakpoint
CREATE FUNCTION system.sweep_model_calls(batch integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  IF batch IS NULL OR batch NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'system.sweep_model_calls: batch must be 1 to 10000';
  END IF;
  DELETE FROM public.model_calls WHERE ctid = ANY (ARRAY(
    SELECT ctid FROM public.model_calls WHERE status <> 'dispatched' AND created_at < now() - interval '13 months' LIMIT batch));
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('sweep_model_calls', found);
  END IF;
  RETURN found;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.sweep_model_calls(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.sweep_model_calls(integer) TO direx_app;
--> statement-breakpoint
CREATE FUNCTION system.sweep_budget_reservations(batch integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  IF batch IS NULL OR batch NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'system.sweep_budget_reservations: batch must be 1 to 10000';
  END IF;
  DELETE FROM public.budget_reservations WHERE ctid = ANY (ARRAY(
    SELECT ctid FROM public.budget_reservations WHERE status <> 'held' AND settled_at < now() - interval '90 days' AND NOT EXISTS (SELECT 1 FROM public.model_calls m WHERE m.workspace_id = budget_reservations.workspace_id AND m.reservation_id = budget_reservations.id) LIMIT batch));
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('sweep_budget_reservations', found);
  END IF;
  RETURN found;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.sweep_budget_reservations(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.sweep_budget_reservations(integer) TO direx_app;
--> statement-breakpoint
CREATE FUNCTION system.sweep_credential_access_events(batch integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  IF batch IS NULL OR batch NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'system.sweep_credential_access_events: batch must be 1 to 10000';
  END IF;
  DELETE FROM public.credential_access_events WHERE ctid = ANY (ARRAY(
    SELECT ctid FROM public.credential_access_events WHERE at < now() - interval '1 year' LIMIT batch));
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('sweep_credential_access_events', found);
  END IF;
  RETURN found;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.sweep_credential_access_events(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.sweep_credential_access_events(integer) TO direx_app;
--> statement-breakpoint
CREATE FUNCTION system.sweep_competitor_snapshots(batch integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  IF batch IS NULL OR batch NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'system.sweep_competitor_snapshots: batch must be 1 to 10000';
  END IF;
  DELETE FROM public.competitor_snapshots WHERE ctid = ANY (ARRAY(
    SELECT ctid FROM public.competitor_snapshots WHERE read_at < now() - interval '1 year' AND EXISTS (SELECT 1 FROM public.competitor_snapshots n WHERE n.workspace_id = competitor_snapshots.workspace_id AND n.competitor_id = competitor_snapshots.competitor_id AND n.source = competitor_snapshots.source AND n.read_at > competitor_snapshots.read_at) LIMIT batch));
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('sweep_competitor_snapshots', found);
  END IF;
  RETURN found;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.sweep_competitor_snapshots(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.sweep_competitor_snapshots(integer) TO direx_app;
