CREATE TABLE "social_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"connection" text NOT NULL,
	"account_type" text NOT NULL,
	"network_id" text NOT NULL,
	"name" text NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_accounts_target_unique" UNIQUE("credential_id","network_id")
);
--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Forced RLS on social_accounts, same workspace policy as the rest.
ALTER TABLE social_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE social_accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON social_accounts
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
