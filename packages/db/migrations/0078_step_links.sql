CREATE TABLE "campaign_step_outputs" (
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"version" integer NOT NULL,
	"url" text NOT NULL,
	"source" text NOT NULL,
	"actor_user_id" uuid,
	"actor_system" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "campaign_step_outputs_pkey" PRIMARY KEY("workspace_id","campaign_id","step_key","version"),
	CONSTRAINT "campaign_step_outputs_version_check" CHECK ("campaign_step_outputs"."version" >= 1),
	CONSTRAINT "campaign_step_outputs_url_check" CHECK ("campaign_step_outputs"."url" like 'https://%' and length("campaign_step_outputs"."url") <= 2048),
	CONSTRAINT "campaign_step_outputs_source_check" CHECK ("campaign_step_outputs"."source" in ('person', 'system')),
	CONSTRAINT "campaign_step_outputs_one_actor_check" CHECK (num_nonnulls("campaign_step_outputs"."actor_user_id", "campaign_step_outputs"."actor_system") = 1),
	CONSTRAINT "campaign_step_outputs_source_matches_actor_check" CHECK (("campaign_step_outputs"."source" = 'person') = ("campaign_step_outputs"."actor_user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD COLUMN "depends_on_step_key" text;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD COLUMN "output_connection" text;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD COLUMN "output_network_id" text;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD COLUMN "utm" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_step_outputs" ADD CONSTRAINT "campaign_step_outputs_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_step_outputs" ADD CONSTRAINT "campaign_step_outputs_step_fk" FOREIGN KEY ("workspace_id","campaign_id","step_key") REFERENCES "public"."campaign_steps"("workspace_id","campaign_id","step_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_depends_on_fk" FOREIGN KEY ("workspace_id","campaign_id","depends_on_step_key") REFERENCES "public"."campaign_steps"("workspace_id","campaign_id","step_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_depends_on_self_check" CHECK ("campaign_steps"."depends_on_step_key" is distinct from "campaign_steps"."step_key");--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_output_account_check" CHECK (("campaign_steps"."output_connection" is null) = ("campaign_steps"."output_network_id" is null) and ("campaign_steps"."output_connection" is null or "campaign_steps"."type" = 'post'));--> statement-breakpoint
-- Forced RLS, same workspace policy as every Workspace table.
ALTER TABLE campaign_step_outputs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE campaign_step_outputs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON campaign_step_outputs
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- An output version is never changed or removed: an approval may rest on it.
REVOKE UPDATE, DELETE ON campaign_step_outputs FROM direx_app;
