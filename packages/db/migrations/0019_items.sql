CREATE TABLE "item_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "item_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"detail" text,
	"version" bigint NOT NULL,
	"actor_user_id" uuid,
	"actor_agent_run_id" uuid,
	"actor_system" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "item_events_one_actor_check" CHECK (num_nonnulls("item_events"."actor_user_id", "item_events"."actor_agent_run_id", "item_events"."actor_system") = 1)
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"action_id" uuid,
	"state" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"described_draft_version" integer,
	"title" text NOT NULL,
	"work_area" text,
	"channel" text,
	"group_key" text,
	"group_label" text,
	"planned_at" timestamp with time zone,
	"warnings" jsonb NOT NULL,
	"snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payload" jsonb,
	"decide_by" timestamp with time zone,
	"snoozed_until" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "items_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "items_workspace_id_action_id_key" UNIQUE("workspace_id","action_id"),
	CONSTRAINT "items_kind_check" CHECK (("items"."kind" = 'action') = ("items"."action_id" is not null)),
	CONSTRAINT "items_one_state_check" CHECK (("items"."action_id" is null) = ("items"."state" is not null)),
	CONSTRAINT "items_state_check" CHECK ("items"."state" in ('draft', 'needs_approval', 'applied', 'cancelled')),
	CONSTRAINT "items_described_version_check" CHECK (("items"."action_id" is null) = ("items"."described_draft_version" is null)),
	CONSTRAINT "items_triage_check" CHECK ("items"."action_id" is null or ("items"."decide_by" is null and "items"."snoozed_until" is null)),
	CONSTRAINT "items_warnings_check" CHECK (jsonb_typeof("items"."warnings") = 'array')
);
--> statement-breakpoint
ALTER TABLE "item_events" ADD CONSTRAINT "item_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_events" ADD CONSTRAINT "item_events_item_fk" FOREIGN KEY ("workspace_id","item_id") REFERENCES "public"."items"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_action_fk" FOREIGN KEY ("workspace_id","action_id") REFERENCES "public"."actions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "item_events_workspace_id_item_id_idx" ON "item_events" USING btree ("workspace_id","item_id");--> statement-breakpoint
CREATE INDEX "items_workspace_id_planned_at_idx" ON "items" USING btree ("workspace_id","planned_at");--> statement-breakpoint
CREATE INDEX "items_workspace_id_created_at_idx" ON "items" USING btree ("workspace_id","created_at");