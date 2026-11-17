CREATE TABLE "agent_model_choice_revisions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "agent_model_choice_revisions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"adapter" text,
	"adapter_model" text,
	"changed_by" uuid NOT NULL,
	"changed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_model_choices" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_model_choice_revisions" ADD CONSTRAINT "agent_model_choice_revisions_changed_by_user_id_fk" FOREIGN KEY ("changed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_model_choice_revisions" ADD CONSTRAINT "agent_model_choice_revisions_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_model_choice_revisions_workspace_id_agent_id_idx" ON "agent_model_choice_revisions" USING btree ("workspace_id","agent","id");