CREATE TABLE "action_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "action_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"reason" text,
	"detail" text,
	"version" bigint NOT NULL,
	"dispatch_gap_ms" integer,
	"actor_user_id" uuid,
	"actor_agent_run_id" uuid,
	"actor_system" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "action_events_one_actor_check" CHECK (num_nonnulls("action_events"."actor_user_id", "action_events"."actor_agent_run_id", "action_events"."actor_system") = 1)
);
--> statement-breakpoint
CREATE TABLE "actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"capability" text NOT NULL,
	"dedupe_class" text NOT NULL,
	"state" text NOT NULL,
	"hold_reason" text,
	"block_reason" text,
	"reason_detail" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"draft_version" integer DEFAULT 1 NOT NULL,
	"spec" jsonb NOT NULL,
	"spec_hash" text NOT NULL,
	"due_at" timestamp with time zone,
	"approval_requested_at" timestamp with time zone,
	"retries" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"first_dispatched_at" timestamp with time zone,
	"correlation_key" text,
	"provider_ref" text,
	"dispatch_started_at" timestamp with time zone,
	"decide_by" timestamp with time zone,
	"snoozed_until" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "actions_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "actions_workspace_id_idempotency_key_key" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "actions_dedupe_class_check" CHECK ("actions"."dedupe_class" in ('provider_idempotent', 'queryable', 'blind')),
	CONSTRAINT "actions_state_check" CHECK ("actions"."state" in ('draft', 'needs_approval', 'scheduled', 'claimed', 'dispatching', 'sent', 'held', 'blocked', 'cancelled')),
	CONSTRAINT "actions_hold_reason_check" CHECK (("actions"."state" = 'held') = ("actions"."hold_reason" is not null)),
	CONSTRAINT "actions_block_reason_check" CHECK (("actions"."state" = 'blocked') = ("actions"."block_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"draft_version" integer NOT NULL,
	"spec_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"approver_id" uuid NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"key_id" text NOT NULL,
	"signature" text NOT NULL,
	"voided_at" timestamp with time zone,
	CONSTRAINT "approvals_workspace_id_id_key" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "action_events" ADD CONSTRAINT "action_events_action_fk" FOREIGN KEY ("workspace_id","action_id") REFERENCES "public"."actions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_action_fk" FOREIGN KEY ("workspace_id","action_id") REFERENCES "public"."actions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_events_workspace_id_action_id_idx" ON "action_events" USING btree ("workspace_id","action_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_one_live_per_action" ON "approvals" USING btree ("workspace_id","action_id") WHERE "approvals"."voided_at" is null;