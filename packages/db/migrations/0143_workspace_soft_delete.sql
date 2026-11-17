-- ADR 0030 rules 003 and 007: deleting a Workspace stops its work at once, and only the database
-- sets the time. The app keeps renaming (UPDATE (name), 0076) but can no longer write deleted_at, so
-- no app code can backdate it past the purge's 30 days. The function runs in the caller's Workspace
-- only, stamps now(), writes the membership audit event the app wrote before, and cancels the
-- Workspace's queued jobs, every one of which carries workspaceId in its data. A running job finishes;
-- what it starts next is refused by the dispatcher or skipped by the sweeps below. Calling it again
-- changes nothing and returns false.
CREATE FUNCTION system.soft_delete_workspace(p_workspace uuid, p_actor uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_jobs integer;
BEGIN
  IF p_workspace IS DISTINCT FROM nullif(current_setting('app.workspace_id', true), '')::uuid THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'DX404';
  END IF;
  UPDATE public.workspaces w SET deleted_at = now() WHERE w.id = p_workspace AND w.deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO public.workspace_audit (workspace_id, event, step_up, actor_user_id, at)
    VALUES (p_workspace, 'workspace.deleted', true, p_actor, now());
  UPDATE pgboss.job j SET state = 'cancelled', completed_on = pgboss.job_now()
    WHERE j.state IN ('created', 'retry') AND j.data->>'workspaceId' = p_workspace::text;
  GET DIAGNOSTICS v_jobs = ROW_COUNT;
  INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('soft_delete_workspace', v_jobs);
  RETURN true;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.soft_delete_workspace(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.soft_delete_workspace(uuid, uuid) TO direx_app;
--> statement-breakpoint
REVOKE UPDATE (deleted_at) ON public.workspaces FROM direx_app;
--> statement-breakpoint
-- The sweeps that find work across Workspaces start none for a deleted one. Each body is the one
-- already on disk with the deleted Workspaces joined out; grants carry over with CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION system.newsletter_workspaces()
RETURNS TABLE (workspace_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY
    SELECT s.workspace_id FROM public.newsletter_settings s
    JOIN public.workspaces w ON w.id = s.workspace_id AND w.deleted_at IS NULL
    WHERE s.enabled;
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('newsletter_workspaces', found);
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION system.competitor_workspaces()
RETURNS TABLE (workspace_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY
    SELECT DISTINCT c.workspace_id FROM public.competitors c
    JOIN public.workspaces w ON w.id = c.workspace_id AND w.deleted_at IS NULL
    ORDER BY c.workspace_id;
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('competitor_workspaces', found);
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION system.active_rule_steps()
RETURNS TABLE (workspace_id uuid, campaign_id uuid, step_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY
    SELECT DISTINCT r.workspace_id, r.campaign_id, r.step_key FROM public.standing_rules r
    JOIN public.workspaces w ON w.id = r.workspace_id AND w.deleted_at IS NULL
    WHERE r.status = 'active' AND r.expires_at > now();
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('active_rule_steps', found);
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION system.per_person_steps()
RETURNS TABLE (workspace_id uuid, campaign_id uuid, step_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY
    SELECT s.workspace_id, s.campaign_id, s.step_key FROM public.campaign_steps s
    JOIN public.campaigns c ON c.workspace_id = s.workspace_id AND c.id = s.campaign_id
    JOIN public.workspaces w ON w.id = s.workspace_id AND w.deleted_at IS NULL
    WHERE s.type = 'email' AND s.drafting_mode = 'per_person' AND c.paused_at IS NULL;
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('per_person_steps', found);
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION system.depended_on_steps()
RETURNS TABLE (workspace_id uuid, campaign_id uuid, step_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY
    SELECT DISTINCT d.workspace_id, d.campaign_id, d.depends_on_step_key FROM public.campaign_steps d
    JOIN public.campaigns c ON c.workspace_id = d.workspace_id AND c.id = d.campaign_id
    JOIN public.campaign_steps s ON s.workspace_id = d.workspace_id AND s.campaign_id = d.campaign_id AND s.step_key = d.depends_on_step_key
    JOIN public.workspaces w ON w.id = d.workspace_id AND w.deleted_at IS NULL
    WHERE d.depends_on_step_key IS NOT NULL AND d.dependency_waived_at IS NULL AND d.cancelled_at IS NULL AND s.cancelled_at IS NULL AND c.paused_at IS NULL;
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('depended_on_steps', found);
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION system.anchored_campaigns()
RETURNS TABLE (workspace_id uuid, campaign_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY
    SELECT c.workspace_id, c.id FROM public.campaigns c
    JOIN public.workspaces w ON w.id = c.workspace_id AND w.deleted_at IS NULL
    WHERE c.anchor_step_key IS NOT NULL AND c.paused_at IS NULL;
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('anchored_campaigns', found);
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION system.unsettled_campaigns()
RETURNS TABLE (workspace_id uuid, campaign_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY
    SELECT DISTINCT s.workspace_id, s.campaign_id FROM public.campaign_settlements s
    JOIN public.workspaces w ON w.id = s.workspace_id AND w.deleted_at IS NULL
    WHERE s.settled_at IS NULL AND (s.claimed_until IS NULL OR s.claimed_until < now());
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('unsettled_campaigns', found);
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION system.connected_mailboxes(connections text[])
RETURNS TABLE (workspace_id uuid, credential_id uuid, connection text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY
    SELECT c.workspace_id, c.id, c.connection FROM public.credentials c
    JOIN public.workspaces w ON w.id = c.workspace_id AND w.deleted_at IS NULL
    WHERE c.connection = ANY (connections) AND c.status = 'active' AND c.deleted_at IS NULL;
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('connected_mailboxes', found);
  END IF;
END
$$;
