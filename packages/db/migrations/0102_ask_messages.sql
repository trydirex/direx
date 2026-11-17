CREATE TABLE "ask_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"item_id" uuid,
	"agent" text,
	"run_id" uuid,
	"reply" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ask_messages_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "ask_messages_run_key" UNIQUE("workspace_id","run_id"),
	CONSTRAINT "ask_messages_text_check" CHECK (length("ask_messages"."text") between 1 and 4000)
);
--> statement-breakpoint
ALTER TABLE "ask_messages" ADD CONSTRAINT "ask_messages_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ask_messages" ADD CONSTRAINT "ask_messages_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ask_messages" ADD CONSTRAINT "ask_messages_item_fk" FOREIGN KEY ("workspace_id","item_id") REFERENCES "public"."items"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ask_messages" ADD CONSTRAINT "ask_messages_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."agent_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ask_messages_conversation" ON "ask_messages" USING btree ("workspace_id","user_id","created_at");--> statement-breakpoint
-- Forced RLS, same workspace policy as the rest. A message is kept; only its reply is written later.
ALTER TABLE ask_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ask_messages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON ask_messages
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE DELETE ON ask_messages FROM direx_app;
