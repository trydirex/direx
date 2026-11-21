CREATE TABLE "outside_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"connection" text NOT NULL,
	"network_id" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"provider_post_id" text NOT NULL,
	"kind" text NOT NULL,
	"origin" text NOT NULL,
	"text" text NOT NULL,
	"links" text[] DEFAULT '{}' NOT NULL,
	"permalink" text,
	"posted_at" timestamp with time zone NOT NULL,
	"edited_at" timestamp with time zone,
	"first_read" boolean NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"keep_until" timestamp with time zone NOT NULL,
	CONSTRAINT "outside_posts_post_key" UNIQUE("workspace_id","connection","provider_account_id","provider_post_id"),
	CONSTRAINT "outside_posts_kind_check" CHECK ("outside_posts"."kind" in ('original', 'quote')),
	CONSTRAINT "outside_posts_origin_check" CHECK ("outside_posts"."origin" in ('outside', 'own', 'possibly_own'))
);
--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "posts_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "posts_read_state" text;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "posts_read_reason" text;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "posts_cursor" text;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "posts_reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_workspace_target_key" UNIQUE("workspace_id","credential_id","network_id");--> statement-breakpoint
ALTER TABLE "outside_posts" ADD CONSTRAINT "outside_posts_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outside_posts" ADD CONSTRAINT "outside_posts_account_fk" FOREIGN KEY ("workspace_id","credential_id","network_id") REFERENCES "public"."social_accounts"("workspace_id","credential_id","network_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outside_posts_window_idx" ON "outside_posts" USING btree ("workspace_id","credential_id","network_id","posted_at");--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_posts_read_check" CHECK ("social_accounts"."posts_read_state" in ('reading', 'ok', 'failed'));--> statement-breakpoint
-- Forced RLS, same workspace policy as every Workspace table. The app deletes a post its network
-- deleted (reconcile); disconnecting the account deletes its posts through the cascade.
ALTER TABLE outside_posts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE outside_posts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON outside_posts
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- The retention sweep (ADR 0030 rule 002), as in 0144: at most `batch` rows past keep_until.
CREATE FUNCTION system.sweep_outside_posts(batch integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  IF batch IS NULL OR batch NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'system.sweep_outside_posts: batch must be 1 to 10000';
  END IF;
  DELETE FROM public.outside_posts WHERE ctid = ANY (ARRAY(
    SELECT ctid FROM public.outside_posts WHERE keep_until < now() LIMIT batch));
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('sweep_outside_posts', found);
  END IF;
  RETURN found;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.sweep_outside_posts(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.sweep_outside_posts(integer) TO direx_app;
