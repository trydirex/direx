CREATE TABLE "agent_model_choices" (
	"workspace_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"adapter" text NOT NULL,
	"adapter_model" text,
	"changed_by" uuid NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_model_choices_workspace_id_agent_pk" PRIMARY KEY("workspace_id","agent")
);
--> statement-breakpoint
CREATE TABLE "model_cli_sign_ins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"owner_user_id" uuid,
	"credential_id" uuid NOT NULL,
	"needs_item_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "model_cli_sign_ins_one_key" UNIQUE NULLS NOT DISTINCT("workspace_id","provider","owner_user_id"),
	CONSTRAINT "model_cli_sign_ins_provider_check" CHECK ("model_cli_sign_ins"."provider" in ('claude_code', 'codex'))
);
--> statement-breakpoint
ALTER TABLE "model_settings_revisions" ADD COLUMN "adapter" text;--> statement-breakpoint
ALTER TABLE "model_settings_revisions" ADD COLUMN "adapter_model" text;--> statement-breakpoint
ALTER TABLE "agent_model_choices" ADD CONSTRAINT "agent_model_choices_changed_by_user_id_fk" FOREIGN KEY ("changed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_model_choices" ADD CONSTRAINT "agent_model_choices_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_cli_sign_ins" ADD CONSTRAINT "model_cli_sign_ins_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_cli_sign_ins" ADD CONSTRAINT "model_cli_sign_ins_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_cli_sign_ins" ADD CONSTRAINT "model_cli_sign_ins_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_cli_sign_ins" ADD CONSTRAINT "model_cli_sign_ins_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;