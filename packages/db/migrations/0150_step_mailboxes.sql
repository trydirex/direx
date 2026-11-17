CREATE TABLE "campaign_step_mailboxes" (
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"credential_id" uuid NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	CONSTRAINT "campaign_step_mailboxes_pkey" PRIMARY KEY("workspace_id","campaign_id","step_key","credential_id")
);
--> statement-breakpoint
ALTER TABLE "campaign_step_mailboxes" ADD CONSTRAINT "campaign_step_mailboxes_step_fk" FOREIGN KEY ("workspace_id","campaign_id","step_key") REFERENCES "public"."campaign_steps"("workspace_id","campaign_id","step_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_step_mailboxes" ADD CONSTRAINT "campaign_step_mailboxes_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Each step's one Mailbox becomes its first. Copied before RLS is forced, which would refuse rows with
-- no Workspace set.
INSERT INTO campaign_step_mailboxes (workspace_id, campaign_id, step_key, credential_id, added_at)
  SELECT workspace_id, campaign_id, step_key, mailbox_credential_id, updated_at FROM campaign_steps
  WHERE mailbox_credential_id IS NOT NULL;
--> statement-breakpoint
-- Forced RLS, same workspace policy as the rest.
ALTER TABLE campaign_step_mailboxes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE campaign_step_mailboxes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON campaign_step_mailboxes
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
