CREATE TABLE "clip_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_media_id" uuid NOT NULL,
	"plan_id" uuid,
	"state" text NOT NULL,
	"transcript" jsonb,
	"duration_ms" integer,
	"agent_run_id" uuid,
	"moments" jsonb,
	"failure" text,
	"started_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "clip_runs_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "clip_runs_state_check" CHECK ("clip_runs"."state" in ('queued', 'transcribing', 'picking', 'cutting', 'done', 'failed')),
	CONSTRAINT "clip_runs_failure_check" CHECK (("clip_runs"."state" = 'failed') = ("clip_runs"."failure" is not null))
);
--> statement-breakpoint
CREATE TABLE "clips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"media_id" uuid NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"title" text NOT NULL,
	"caption" text NOT NULL,
	"citations" jsonb NOT NULL,
	"measure_key" text,
	"why" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "clips_run_position_key" UNIQUE("workspace_id","run_id","position"),
	CONSTRAINT "clips_times_check" CHECK ("clips"."start_ms" >= 0 and "clips"."end_ms" > "clips"."start_ms")
);
--> statement-breakpoint
ALTER TABLE "clip_runs" ADD CONSTRAINT "clip_runs_started_by_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_runs" ADD CONSTRAINT "clip_runs_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_runs" ADD CONSTRAINT "clip_runs_source_fk" FOREIGN KEY ("workspace_id","source_media_id") REFERENCES "public"."media"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."clip_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_media_fk" FOREIGN KEY ("workspace_id","media_id") REFERENCES "public"."media"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clip_runs_one_live_per_source" ON "clip_runs" USING btree ("workspace_id","source_media_id") WHERE "clip_runs"."state" not in ('done', 'failed');--> statement-breakpoint
-- Forced RLS, same workspace policy as the rest. Runs and clips are never deleted.
ALTER TABLE clip_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE clip_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON clip_runs
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE DELETE ON clip_runs FROM direx_app;
--> statement-breakpoint
ALTER TABLE clips ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE clips FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON clips
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE DELETE ON clips FROM direx_app;
