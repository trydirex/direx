ALTER TABLE "campaign_steps" ADD COLUMN "dependency_waived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD COLUMN "dependency_waived_by" uuid;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD COLUMN "cancelled_by" uuid;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD COLUMN "stall_wait_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "anchor_on" date;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "anchor_step_key" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "anchor_moved_by" uuid;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "anchor_moved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_dependency_waived_by_user_id_fk" FOREIGN KEY ("dependency_waived_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_cancelled_by_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_anchor_moved_by_user_id_fk" FOREIGN KEY ("anchor_moved_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_waived_check" CHECK (("campaign_steps"."dependency_waived_at" is null) = ("campaign_steps"."dependency_waived_by" is null));--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_cancelled_check" CHECK (("campaign_steps"."cancelled_at" is null) = ("campaign_steps"."cancelled_by" is null));--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_anchor_moved_check" CHECK (("campaigns"."anchor_moved_by" is null) = ("campaigns"."anchor_moved_at" is null));--> statement-breakpoint
-- Lists steps others wait on, in Campaigns that aren't paused, across Workspaces, for the daily job that asks what to do when their output never comes. Ids only.
CREATE FUNCTION system.depended_on_steps()
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
    WHERE d.depends_on_step_key IS NOT NULL AND d.dependency_waived_at IS NULL AND d.cancelled_at IS NULL AND s.cancelled_at IS NULL AND c.paused_at IS NULL;
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('depended_on_steps', found);
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.depended_on_steps() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.depended_on_steps() TO direx_app;
