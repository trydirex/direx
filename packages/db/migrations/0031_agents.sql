CREATE TABLE "agent_cancellations" (
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source" text NOT NULL,
	"who" uuid,
	"reason" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_cancellations_pkey" PRIMARY KEY("workspace_id","run_id"),
	CONSTRAINT "agent_cancellations_source_check" CHECK ("agent_cancellations"."source" in ('person', 'admin', 'queued_message', 'shutdown', 'emergency_pause')),
	CONSTRAINT "agent_cancellations_who_check" CHECK ("agent_cancellations"."source" not in ('person', 'admin') or "agent_cancellations"."who" is not null)
);
--> statement-breakpoint
CREATE TABLE "agent_proposals" (
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"output_key" text NOT NULL,
	"kind" text NOT NULL,
	"item_id" uuid,
	"rejection_code" text,
	"incomplete" boolean DEFAULT false NOT NULL,
	"route_hash" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_proposals_pkey" PRIMARY KEY("workspace_id","run_id","output_key")
);
--> statement-breakpoint
CREATE TABLE "agent_run_events" (
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"arguments_digest" text,
	"result_digest" text,
	"outcome" text NOT NULL,
	"model_call_id" uuid,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_run_events_pkey" PRIMARY KEY("workspace_id","run_id","seq"),
	CONSTRAINT "agent_run_events_kind_check" CHECK ("agent_run_events"."kind" in ('model_call', 'tool_call', 'proposal', 'rejection'))
);
--> statement-breakpoint
CREATE TABLE "agent_run_parts" (
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"version" text,
	"digest" text NOT NULL,
	"trust" text NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_run_parts_pkey" PRIMARY KEY("workspace_id","run_id","seq"),
	CONSTRAINT "agent_run_parts_trust_check" CHECK ("agent_run_parts"."trust" in ('trusted', 'untrusted'))
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"agent" text NOT NULL,
	"definition_version" integer NOT NULL,
	"prompt_revision" text NOT NULL,
	"prompt_digest" text NOT NULL,
	"tool_set_digest" text NOT NULL,
	"trigger" text NOT NULL,
	"started_by" uuid,
	"status" text NOT NULL,
	"status_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"reclaims" integer DEFAULT 0 NOT NULL,
	"retries" integer DEFAULT 0 NOT NULL,
	"admitted_at" timestamp with time zone,
	"resume_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"deadline_ms" integer NOT NULL,
	"deadline_at" timestamp with time zone,
	"step_cap" integer NOT NULL,
	"steps" integer DEFAULT 0 NOT NULL,
	"cost_cap_micros" bigint NOT NULL,
	"tainted" boolean DEFAULT false NOT NULL,
	"unevaluated" boolean DEFAULT false NOT NULL,
	"aggregate_digest" text,
	"input" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "agent_runs_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "agent_runs_idempotency_key" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "agent_runs_status_check" CHECK ("agent_runs"."status" in ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'timed_out', 'step_capped', 'cost_capped', 'refused', 'expired')),
	CONSTRAINT "agent_runs_waiting_reason_check" CHECK ("agent_runs"."status" <> 'waiting' or coalesce("agent_runs"."status_reason", '') in ('daily_cap', 'budget_stop')),
	CONSTRAINT "agent_runs_failed_reason_check" CHECK ("agent_runs"."status" not in ('failed', 'refused') or "agent_runs"."status_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "agent_setting_revisions" (
	"workspace_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"revision" integer NOT NULL,
	"settings" jsonb NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_setting_revisions_pkey" PRIMARY KEY("workspace_id","agent","revision")
);
--> statement-breakpoint
CREATE TABLE "agent_settings" (
	"workspace_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"max_concurrent_runs" integer,
	"max_daily_runs" integer,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_settings_pkey" PRIMARY KEY("workspace_id","agent")
);
--> statement-breakpoint
ALTER TABLE "agent_cancellations" ADD CONSTRAINT "agent_cancellations_who_user_id_fk" FOREIGN KEY ("who") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_cancellations" ADD CONSTRAINT "agent_cancellations_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."agent_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."agent_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."agent_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_parts" ADD CONSTRAINT "agent_run_parts_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."agent_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_started_by_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_setting_revisions" ADD CONSTRAINT "agent_setting_revisions_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_setting_revisions" ADD CONSTRAINT "agent_setting_revisions_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_settings" ADD CONSTRAINT "agent_settings_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_recent" ON "agent_runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_admission" ON "agent_runs" USING btree ("workspace_id","agent","status");