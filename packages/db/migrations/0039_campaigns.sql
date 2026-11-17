CREATE TABLE "campaign_actions" (
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"person_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	CONSTRAINT "campaign_actions_pkey" PRIMARY KEY("workspace_id","campaign_id","step_key","person_id")
);
--> statement-breakpoint
CREATE TABLE "campaign_people" (
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"first_name" text,
	"company" text,
	"website" text,
	"added_by" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "campaign_people_pkey" PRIMARY KEY("workspace_id","campaign_id","person_id"),
	CONSTRAINT "campaign_people_status_check" CHECK ("campaign_people"."status" in ('active', 'replied', 'removed', 'conflict'))
);
--> statement-breakpoint
CREATE TABLE "campaign_steps" (
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"type" text NOT NULL,
	"touch_class" text DEFAULT 'cold' NOT NULL,
	"mailbox_credential_id" uuid,
	"audience" text DEFAULT 'everyone' NOT NULL,
	"template" jsonb,
	"template_revision" integer DEFAULT 0 NOT NULL,
	"draft_run_id" uuid,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "campaign_steps_pkey" PRIMARY KEY("workspace_id","campaign_id","step_key"),
	CONSTRAINT "campaign_steps_type_check" CHECK ("campaign_steps"."type" in ('email', 'manual')),
	CONSTRAINT "campaign_steps_touch_class_check" CHECK ("campaign_steps"."touch_class" in ('cold', 'consented_marketing')),
	CONSTRAINT "campaign_steps_audience_check" CHECK ("campaign_steps"."audience" in ('everyone', 'no_reply_yet'))
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"drafting_mode" text,
	"paused_at" timestamp with time zone,
	"paused_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "campaigns_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "campaigns_one_per_plan" UNIQUE("workspace_id","plan_id"),
	CONSTRAINT "campaigns_drafting_mode_check" CHECK ("campaigns"."drafting_mode" in ('template', 'per_person'))
);
--> statement-breakpoint
ALTER TABLE "campaign_actions" ADD CONSTRAINT "campaign_actions_person_fk" FOREIGN KEY ("workspace_id","campaign_id","person_id") REFERENCES "public"."campaign_people"("workspace_id","campaign_id","person_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_actions" ADD CONSTRAINT "campaign_actions_action_fk" FOREIGN KEY ("workspace_id","action_id") REFERENCES "public"."actions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_people" ADD CONSTRAINT "campaign_people_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_people" ADD CONSTRAINT "campaign_people_campaign_fk" FOREIGN KEY ("workspace_id","campaign_id") REFERENCES "public"."campaigns"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_people" ADD CONSTRAINT "campaign_people_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_campaign_fk" FOREIGN KEY ("workspace_id","campaign_id") REFERENCES "public"."campaigns"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_mailbox_fk" FOREIGN KEY ("workspace_id","mailbox_credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_paused_by_user_id_fk" FOREIGN KEY ("paused_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_plan_fk" FOREIGN KEY ("workspace_id","plan_id") REFERENCES "public"."marketing_plans"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_actions_action_idx" ON "campaign_actions" USING btree ("workspace_id","action_id");--> statement-breakpoint
CREATE INDEX "campaign_people_person_idx" ON "campaign_people" USING btree ("workspace_id","person_id");