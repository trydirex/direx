CREATE TABLE "social_account_health" (
	"workspace_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"network_id" text NOT NULL,
	"posts" integer NOT NULL,
	"replies" integer NOT NULL,
	"links" integer NOT NULL,
	"posts_lower" integer,
	"replies_lower" integer,
	"links_lower" integer,
	"clean_since" timestamp with time zone NOT NULL,
	"paused_at" timestamp with time zone,
	"pause_reason" text,
	"pause_detail" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "social_account_health_account" UNIQUE("workspace_id","credential_id","network_id"),
	CONSTRAINT "social_account_health_counts_check" CHECK ("social_account_health"."posts" >= 0 and "social_account_health"."replies" >= 0 and "social_account_health"."links" >= 0),
	CONSTRAINT "social_account_health_pause_check" CHECK (("social_account_health"."paused_at" is null) = ("social_account_health"."pause_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "social_account_health" ADD CONSTRAINT "social_account_health_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Forced RLS, same workspace policy as the rest. A row stays for the account's life, so no deletes.
ALTER TABLE social_account_health ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE social_account_health FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON social_account_health
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE DELETE ON social_account_health FROM direx_app;
