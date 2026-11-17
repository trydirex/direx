CREATE TABLE "clip_step_runs" (
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"run_id" uuid NOT NULL,
	"setup" jsonb NOT NULL,
	"started_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "clip_step_runs_pkey" PRIMARY KEY("workspace_id","run_id")
);
--> statement-breakpoint
ALTER TABLE "campaign_steps" DROP CONSTRAINT "campaign_steps_clip_setup_check";--> statement-breakpoint
ALTER TABLE "clip_step_runs" ADD CONSTRAINT "clip_step_runs_started_by_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_step_runs" ADD CONSTRAINT "clip_step_runs_step_fk" FOREIGN KEY ("workspace_id","campaign_id","step_key") REFERENCES "public"."campaign_steps"("workspace_id","campaign_id","step_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clip_step_runs_step_idx" ON "clip_step_runs" USING btree ("workspace_id","campaign_id","step_key","created_at");--> statement-breakpoint
-- Each step's one recording moves to the list before its columns go. FORCE RLS applies to the owner
-- too, so it is lifted on both tables for the copy, and the copy fails the migration if any recording
-- is left behind.
ALTER TABLE campaign_steps NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO clip_step_runs (workspace_id, campaign_id, step_key, run_id, setup, started_by, created_at)
SELECT workspace_id, campaign_id, step_key, clip_run_id, clip_setup - 'userId', (clip_setup->>'userId')::uuid, updated_at
FROM campaign_steps WHERE clip_run_id IS NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM campaign_steps s WHERE s.clip_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM clip_step_runs r WHERE r.workspace_id = s.workspace_id AND r.run_id = s.clip_run_id)) THEN
    RAISE EXCEPTION 'clip_step_runs: a recording was not copied';
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE campaign_steps FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "campaign_steps" DROP COLUMN "clip_setup";--> statement-breakpoint
ALTER TABLE "campaign_steps" DROP COLUMN "clip_run_id";
--> statement-breakpoint
-- Forced RLS, same workspace policy as the rest. A recording is never deleted or changed.
ALTER TABLE clip_step_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE clip_step_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON clip_step_runs
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON clip_step_runs FROM direx_app;
