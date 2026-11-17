ALTER TABLE "credential_access_events" DROP CONSTRAINT "credential_access_events_consumer_check";--> statement-breakpoint
ALTER TABLE "credential_access_events" ADD CONSTRAINT "credential_access_events_consumer_check" CHECK ("credential_access_events"."consumer" in ('execute', 'reconcile', 'query', 'poll', 'model_call', 'mcp_call', 'startup', 'webhook', 'create', 'rotate', 'connect', 'disconnect', 'delete'));--> statement-breakpoint
-- Replacing the root key: once every data key is wrapped by the new key, the deployment's recorded
-- key moves from the old id to the new one. A data key still under any other root key refuses
-- the change, so the record never names a key that can't open every Workspace. The app role
-- still can't update the row itself.
CREATE FUNCTION system.replace_deployment_root_key(old_key text, new_key text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  changed integer;
BEGIN
  IF EXISTS (SELECT 1 FROM public.workspace_keys k WHERE k.root_key_id <> new_key) THEN
    RETURN false;
  END IF;
  UPDATE public.deployment_root_key SET root_key_id = new_key WHERE root_key_id = old_key;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('replace_deployment_root_key', changed);
  END IF;
  RETURN changed > 0;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.replace_deployment_root_key(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.replace_deployment_root_key(text, text) TO direx_app;
