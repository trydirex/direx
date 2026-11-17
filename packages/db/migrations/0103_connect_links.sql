CREATE TABLE "connect_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"issued_by" uuid NOT NULL,
	"connection" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"state_hash" text,
	"sealed_state" text,
	"used_at" timestamp with time zone,
	"credential_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "connect_links_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "connect_links_state_hash_key" UNIQUE("state_hash")
);
--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "run_by" text;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "angle" text;--> statement-breakpoint
ALTER TABLE "connect_links" ADD CONSTRAINT "connect_links_issued_by_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_links" ADD CONSTRAINT "connect_links_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_links" ADD CONSTRAINT "connect_links_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connect_links_issuer_idx" ON "connect_links" USING btree ("workspace_id","issued_by","created_at");--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_about_check" CHECK (char_length("social_accounts"."run_by") <= 200 and char_length("social_accounts"."angle") <= 200);--> statement-breakpoint
-- Forced RLS, same workspace policy as the rest. A link stays as the record of who connected what, so no deletes.
ALTER TABLE connect_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE connect_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON connect_links
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE DELETE ON connect_links FROM direx_app;
