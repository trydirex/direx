CREATE TABLE "plugin_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"plugin_id" text NOT NULL,
	"trigger" text NOT NULL,
	"credential_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "plugin_webhooks_one_per_trigger" UNIQUE("workspace_id","plugin_id","trigger")
);
--> statement-breakpoint
ALTER TABLE "plugin_webhooks" ADD CONSTRAINT "plugin_webhooks_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_webhooks" ADD CONSTRAINT "plugin_webhooks_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_webhooks" ADD CONSTRAINT "plugin_webhooks_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE plugin_webhooks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE plugin_webhooks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON plugin_webhooks
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- A webhook's address and its secret change only by rotating the secret, never by moving the row.
REVOKE UPDATE, DELETE ON plugin_webhooks FROM direx_app;
