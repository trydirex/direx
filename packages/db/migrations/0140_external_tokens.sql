CREATE TABLE "external_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"hint" text NOT NULL,
	"readers" text[] NOT NULL,
	"kinds" text[] NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_by" uuid,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "external_tokens_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "external_tokens_workspace_id_token_hash_key" UNIQUE("workspace_id","token_hash"),
	CONSTRAINT "external_tokens_name_check" CHECK (char_length("external_tokens"."name") between 1 and 60),
	CONSTRAINT "external_tokens_token_hash_check" CHECK ("external_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "external_tokens_hint_check" CHECK (char_length("external_tokens"."hint") = 4),
	CONSTRAINT "external_tokens_expiry_check" CHECK ("external_tokens"."expires_at" > "external_tokens"."created_at" and "external_tokens"."expires_at" <= "external_tokens"."created_at" + interval '365 days'),
	CONSTRAINT "external_tokens_revoked_check" CHECK (("external_tokens"."revoked_by" is null) = ("external_tokens"."revoked_at" is null))
);
--> statement-breakpoint
ALTER TABLE "workspace_audit" ADD COLUMN "subject_token_id" uuid;--> statement-breakpoint
ALTER TABLE "external_tokens" ADD CONSTRAINT "external_tokens_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_tokens" ADD CONSTRAINT "external_tokens_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_tokens" ADD CONSTRAINT "external_tokens_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE external_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE external_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON external_tokens
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- A token's hash, name, scope and expiry never change, and a token is never deleted: the app may
-- only record a revocation and the last use (ADR 0032 rule 005).
REVOKE UPDATE, DELETE ON external_tokens FROM direx_app;
--> statement-breakpoint
GRANT UPDATE (revoked_by, revoked_at, last_used_at) ON external_tokens TO direx_app;
