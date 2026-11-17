-- ADR 0023 rule 005: Delete draft. The one way a Campaign, its plan and the plan's versions are removed, for a
-- plan never approved. The app role keeps no DELETE on these tables (0034, 0040); this function is the narrow
-- exception. It runs in the caller's Workspace only, takes the plan row lock approval takes (lockPlan), and
-- refuses, each with its own SQLSTATE, rather than cascade through anything else that points at the draft:
--   DX404 not found (another Workspace, or no such plan), DXAPR a version was ever approved,
--   DXRUN a plan drafter run is still live, DXREF any other row references the Campaign or the plan.
-- Items, their events, and agent runs keep the plan id as history.
CREATE FUNCTION system.delete_draft_campaign(p_workspace uuid, p_plan uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_current integer;
  v_campaign uuid;
BEGIN
  IF p_workspace IS DISTINCT FROM nullif(current_setting('app.workspace_id', true), '')::uuid THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'DX404';
  END IF;
  SELECT p.current_version INTO v_current FROM public.marketing_plans p
    WHERE p.workspace_id = p_workspace AND p.id = p_plan FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'DX404';
  END IF;
  IF v_current IS NOT NULL OR EXISTS (
    SELECT 1 FROM public.items i JOIN public.item_events e ON e.workspace_id = i.workspace_id AND e.item_id = i.id
    WHERE i.workspace_id = p_workspace AND i.kind = 'plan_version' AND i.payload->>'targetId' = p_plan::text AND e.to_state = 'applied'
  ) THEN
    RAISE EXCEPTION 'plan_approved' USING ERRCODE = 'DXAPR';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.agent_runs r
    WHERE r.workspace_id = p_workspace AND r.agent = 'plan_drafter' AND r.input->'target'->>'id' = p_plan::text
      AND r.status IN ('queued', 'running', 'waiting')
  ) THEN
    RAISE EXCEPTION 'drafter_running' USING ERRCODE = 'DXRUN';
  END IF;
  SELECT c.id INTO v_campaign FROM public.campaigns c WHERE c.workspace_id = p_workspace AND c.plan_id = p_plan;
  IF EXISTS (SELECT 1 FROM public.plan_step_progress x WHERE x.workspace_id = p_workspace AND x.plan_id = p_plan)
    OR EXISTS (SELECT 1 FROM public.plan_measure_readings x WHERE x.workspace_id = p_workspace AND x.plan_id = p_plan)
    OR EXISTS (SELECT 1 FROM public.clip_runs x WHERE x.workspace_id = p_workspace AND x.plan_id = p_plan)
    OR EXISTS (SELECT 1 FROM public.campaign_steps x WHERE x.workspace_id = p_workspace AND x.campaign_id = v_campaign)
    OR EXISTS (SELECT 1 FROM public.campaign_people x WHERE x.workspace_id = p_workspace AND (x.campaign_id = v_campaign OR x.after_campaign_id = v_campaign))
    OR EXISTS (SELECT 1 FROM public.campaign_actions x WHERE x.workspace_id = p_workspace AND x.campaign_id = v_campaign)
    OR EXISTS (SELECT 1 FROM public.campaign_dms x WHERE x.workspace_id = p_workspace AND x.campaign_id = v_campaign)
    OR EXISTS (SELECT 1 FROM public.campaign_step_outputs x WHERE x.workspace_id = p_workspace AND x.campaign_id = v_campaign)
    OR EXISTS (SELECT 1 FROM public.campaign_plan_changes x WHERE x.workspace_id = p_workspace AND x.campaign_id = v_campaign)
    OR EXISTS (SELECT 1 FROM public.campaign_settlements x WHERE x.workspace_id = p_workspace AND x.campaign_id = v_campaign)
    OR EXISTS (SELECT 1 FROM public.clip_step_runs x WHERE x.workspace_id = p_workspace AND x.campaign_id = v_campaign)
    OR EXISTS (SELECT 1 FROM public.social_posts x WHERE x.workspace_id = p_workspace AND x.campaign_id = v_campaign)
    OR EXISTS (SELECT 1 FROM public.standing_rules x WHERE x.workspace_id = p_workspace AND x.campaign_id = v_campaign)
    OR EXISTS (SELECT 1 FROM public.placement_content_tests x WHERE x.workspace_id = p_workspace AND x.campaign_id = v_campaign)
    OR EXISTS (SELECT 1 FROM public.prospect_handovers x WHERE x.workspace_id = p_workspace AND x.campaign_id = v_campaign)
    OR EXISTS (SELECT 1 FROM public.review_decisions x WHERE x.workspace_id = p_workspace AND x.campaign_id = v_campaign)
  THEN
    RAISE EXCEPTION 'draft_in_use' USING ERRCODE = 'DXREF';
  END IF;
  DELETE FROM public.campaigns c WHERE c.workspace_id = p_workspace AND c.id = v_campaign;
  DELETE FROM public.marketing_plan_versions v WHERE v.workspace_id = p_workspace AND v.plan_id = p_plan;
  DELETE FROM public.marketing_plans p WHERE p.workspace_id = p_workspace AND p.id = p_plan;
  INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('delete_draft_campaign', 1);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.delete_draft_campaign(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.delete_draft_campaign(uuid, uuid) TO direx_app;
