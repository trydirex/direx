CREATE TABLE "newsletter_subscribers" (
	"workspace_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"email" text NOT NULL,
	"state" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "newsletter_subscribers_workspace_id_credential_id_email_pk" PRIMARY KEY("workspace_id","credential_id","email"),
	CONSTRAINT "newsletter_subscribers_state_check" CHECK ("newsletter_subscribers"."state" in ('subscribed', 'unsubscribed', 'bounced', 'complained', 'other')),
	CONSTRAINT "newsletter_subscribers_email_check" CHECK ("newsletter_subscribers"."email" = lower("newsletter_subscribers"."email"))
);
--> statement-breakpoint
ALTER TABLE "newsletter_subscribers" ADD CONSTRAINT "newsletter_subscribers_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_subscribers" ADD CONSTRAINT "newsletter_subscribers_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "newsletter_subscribers_email_idx" ON "newsletter_subscribers" USING btree ("workspace_id","email");--> statement-breakpoint
-- Forced RLS, same workspace policy as the other outreach tables.
ALTER TABLE newsletter_subscribers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE newsletter_subscribers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON newsletter_subscribers
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Anyone once on a list stays kept out of cold email: the product updates a row's state and
-- last-seen time, and never removes one.
REVOKE DELETE ON newsletter_subscribers FROM direx_app;