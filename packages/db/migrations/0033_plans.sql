CREATE TABLE "marketing_plan_versions" (
	"workspace_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body" jsonb NOT NULL,
	"digest" text NOT NULL,
	"base_version" integer,
	"strategy_id" uuid NOT NULL,
	"strategy_version" integer NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "marketing_plan_versions_pkey" PRIMARY KEY("workspace_id","plan_id","version")
);
--> statement-breakpoint
CREATE TABLE "marketing_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"request" text,
	"current_version" integer,
	"draft" jsonb,
	"draft_revision" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "marketing_plans_workspace_id_id_key" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "plan_measure_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"measure_key" text NOT NULL,
	"value" text NOT NULL,
	"observed_on" date NOT NULL,
	"source" text NOT NULL,
	"note" text,
	"actor_user_id" uuid,
	"actor_system" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "plan_measure_readings_source_check" CHECK ("plan_measure_readings"."source" in ('person', 'system')),
	CONSTRAINT "plan_measure_readings_one_actor_check" CHECK (num_nonnulls("plan_measure_readings"."actor_user_id", "plan_measure_readings"."actor_system") = 1),
	CONSTRAINT "plan_measure_readings_source_matches_actor_check" CHECK (("plan_measure_readings"."source" = 'person') = ("plan_measure_readings"."actor_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "plan_step_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"status" text NOT NULL,
	"actor_user_id" uuid,
	"actor_system" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "plan_step_progress_status_check" CHECK ("plan_step_progress"."status" in ('done', 'skipped', 'open')),
	CONSTRAINT "plan_step_progress_one_actor_check" CHECK (num_nonnulls("plan_step_progress"."actor_user_id", "plan_step_progress"."actor_system") = 1)
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"current_version" integer,
	"draft" jsonb,
	"draft_revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "strategies_one_per_workspace" UNIQUE("workspace_id"),
	CONSTRAINT "strategies_workspace_id_id_key" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "strategy_versions" (
	"workspace_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body" jsonb NOT NULL,
	"digest" text NOT NULL,
	"base_version" integer,
	"actor_user_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "strategy_versions_pkey" PRIMARY KEY("workspace_id","strategy_id","version")
);
--> statement-breakpoint
ALTER TABLE "marketing_plan_versions" ADD CONSTRAINT "marketing_plan_versions_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_plan_versions" ADD CONSTRAINT "marketing_plan_versions_plan_fk" FOREIGN KEY ("workspace_id","plan_id") REFERENCES "public"."marketing_plans"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_plan_versions" ADD CONSTRAINT "marketing_plan_versions_strategy_fk" FOREIGN KEY ("workspace_id","strategy_id","strategy_version") REFERENCES "public"."strategy_versions"("workspace_id","strategy_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_plans" ADD CONSTRAINT "marketing_plans_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_measure_readings" ADD CONSTRAINT "plan_measure_readings_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_measure_readings" ADD CONSTRAINT "plan_measure_readings_plan_fk" FOREIGN KEY ("workspace_id","plan_id") REFERENCES "public"."marketing_plans"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_step_progress" ADD CONSTRAINT "plan_step_progress_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_step_progress" ADD CONSTRAINT "plan_step_progress_plan_fk" FOREIGN KEY ("workspace_id","plan_id") REFERENCES "public"."marketing_plans"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_strategy_fk" FOREIGN KEY ("workspace_id","strategy_id") REFERENCES "public"."strategies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_measure_readings_plan_idx" ON "plan_measure_readings" USING btree ("workspace_id","plan_id","at");--> statement-breakpoint
CREATE INDEX "plan_step_progress_plan_idx" ON "plan_step_progress" USING btree ("workspace_id","plan_id","at");