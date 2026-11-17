ALTER TABLE "campaign_steps" ADD COLUMN "drafting_mode" text;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_drafting_mode_check" CHECK ("campaign_steps"."drafting_mode" in ('template', 'per_person'));--> statement-breakpoint
-- Existing email steps keep the mode their Campaign was written in; one never answered gets a template.
UPDATE "campaign_steps" s SET "drafting_mode" = coalesce(c."drafting_mode", 'template') FROM "campaigns" c WHERE c."workspace_id" = s."workspace_id" AND c."id" = s."campaign_id" AND s."type" = 'email';
--> statement-breakpoint
-- Lists email steps written per Person across Workspaces, for the daily job that offers drafting their follow-ups. Ids only.
CREATE FUNCTION system.per_person_steps()
RETURNS TABLE (workspace_id uuid, campaign_id uuid, step_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY
    SELECT s.workspace_id, s.campaign_id, s.step_key FROM public.campaign_steps s
    JOIN public.campaigns c ON c.workspace_id = s.workspace_id AND c.id = s.campaign_id
    WHERE s.type = 'email' AND s.drafting_mode = 'per_person' AND c.paused_at IS NULL;
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('per_person_steps', found);
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.per_person_steps() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.per_person_steps() TO direx_app;
