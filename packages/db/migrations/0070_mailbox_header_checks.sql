CREATE TABLE "mailbox_header_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "mailbox_header_checks_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"probe_action_id" uuid,
	"probe_subject" text,
	"settings_hash" text NOT NULL,
	"state" text NOT NULL,
	"failures" text[] DEFAULT '{}'::text[] NOT NULL,
	"warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "mailbox_header_checks_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "mailbox_header_checks_state_check" CHECK ("mailbox_header_checks"."state" in ('unchecked', 'pending', 'passed', 'replies_only', 'failed', 'inconclusive'))
);
--> statement-breakpoint
ALTER TABLE "mailbox_header_checks" ADD CONSTRAINT "mailbox_header_checks_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_header_checks" ADD CONSTRAINT "mailbox_header_checks_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_header_checks" ADD CONSTRAINT "mailbox_header_checks_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_header_checks" ADD CONSTRAINT "mailbox_header_checks_action_fk" FOREIGN KEY ("workspace_id","probe_action_id") REFERENCES "public"."actions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mailbox_header_checks_current_idx" ON "mailbox_header_checks" USING btree ("workspace_id","credential_id","seq");--> statement-breakpoint
-- Forced RLS, same workspace policy as every Workspace table.
ALTER TABLE mailbox_header_checks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mailbox_header_checks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON mailbox_header_checks
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- A check is a record of what a provider did: a new probe adds a row, and none is ever removed.
REVOKE DELETE ON mailbox_header_checks FROM direx_app;
