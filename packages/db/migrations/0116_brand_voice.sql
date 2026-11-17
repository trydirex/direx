CREATE TABLE "brand_sample_revisions" (
	"workspace_id" uuid NOT NULL,
	"sample_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"subject" text,
	"text" text NOT NULL,
	"digest" text NOT NULL,
	"run_id" uuid NOT NULL,
	"asked" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "brand_sample_revisions_pkey" PRIMARY KEY("workspace_id","sample_id","revision"),
	CONSTRAINT "brand_sample_revisions_text_check" CHECK (char_length("brand_sample_revisions"."text") between 1 and 4000)
);
--> statement-breakpoint
CREATE TABLE "brand_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"current_revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "brand_samples_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "brand_samples_one_per_kind" UNIQUE("workspace_id","kind"),
	CONSTRAINT "brand_samples_kind_check" CHECK ("brand_samples"."kind" in ('linkedin_post', 'cold_email', 'newsletter_opening')),
	CONSTRAINT "brand_samples_revision_check" CHECK ("brand_samples"."current_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "voice_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"current_version" integer NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "voice_entries_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "voice_entries_kind_check" CHECK ("voice_entries"."kind" in ('example', 'swap')),
	CONSTRAINT "voice_entries_version_check" CHECK ("voice_entries"."current_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "voice_versions" (
	"workspace_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"text" text,
	"prefer" text,
	"source" text NOT NULL,
	"sample_id" uuid,
	"sample_revision" integer,
	"sample_digest" text,
	"digest" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"erased_at" timestamp with time zone,
	CONSTRAINT "voice_versions_pkey" PRIMARY KEY("workspace_id","entry_id","version"),
	CONSTRAINT "voice_versions_source_check" CHECK ("voice_versions"."source" in ('person', 'sample')),
	CONSTRAINT "voice_versions_sample_check" CHECK (("voice_versions"."source" = 'sample') = (num_nonnulls("voice_versions"."sample_id", "voice_versions"."sample_revision", "voice_versions"."sample_digest") = 3)),
	CONSTRAINT "voice_versions_erased_check" CHECK (("voice_versions"."erased_at" is null) = ("voice_versions"."text" is not null)),
	CONSTRAINT "voice_versions_erased_prefer_check" CHECK ("voice_versions"."erased_at" is null or "voice_versions"."prefer" is null),
	CONSTRAINT "voice_versions_length_check" CHECK (char_length("voice_versions"."text") <= 600 and char_length("voice_versions"."prefer") <= 40)
);
--> statement-breakpoint
ALTER TABLE "brand_sample_revisions" ADD CONSTRAINT "brand_sample_revisions_sample_fk" FOREIGN KEY ("workspace_id","sample_id") REFERENCES "public"."brand_samples"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_sample_revisions" ADD CONSTRAINT "brand_sample_revisions_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."agent_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_samples" ADD CONSTRAINT "brand_samples_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_entries" ADD CONSTRAINT "voice_entries_retired_by_user_id_fk" FOREIGN KEY ("retired_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_entries" ADD CONSTRAINT "voice_entries_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_versions" ADD CONSTRAINT "voice_versions_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_versions" ADD CONSTRAINT "voice_versions_entry_fk" FOREIGN KEY ("workspace_id","entry_id") REFERENCES "public"."voice_entries"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Forced RLS, same workspace policy as the rest.
ALTER TABLE brand_samples ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE brand_samples FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON brand_samples
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE brand_sample_revisions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE brand_sample_revisions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON brand_sample_revisions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE voice_entries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE voice_entries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON voice_entries
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE voice_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE voice_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON voice_versions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- A sample keeps its revisions and is never removed; a rewrite adds a revision. A Voice entry is
-- retired, never removed, and its versions never change except to be erased.
REVOKE DELETE ON brand_samples FROM direx_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON brand_sample_revisions FROM direx_app;
--> statement-breakpoint
REVOKE DELETE ON voice_entries FROM direx_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON voice_versions FROM direx_app;
--> statement-breakpoint
GRANT UPDATE (text, prefer, erased_at) ON voice_versions TO direx_app;
--> statement-breakpoint
-- Erasure keeps the id and digest and drops the words, once; no other change is allowed.
CREATE FUNCTION voice_versions_erase_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.erased_at IS NOT NULL OR NEW.erased_at IS NULL OR NEW.text IS NOT NULL OR NEW.prefer IS NOT NULL THEN
    RAISE EXCEPTION 'voice_versions_erase_only';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER voice_versions_erase_only BEFORE UPDATE ON voice_versions FOR EACH ROW EXECUTE FUNCTION voice_versions_erase_only();
