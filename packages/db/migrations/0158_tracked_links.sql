CREATE TABLE "tracked_link_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"link_id" text NOT NULL,
	"action_id" uuid,
	"dm_id" uuid,
	"token_hash" text,
	"person_id" uuid,
	"inputs_hash" text NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tracked_link_uses_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "tracked_link_uses_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "tracked_link_uses_one_message_check" CHECK (("tracked_link_uses"."action_id" is null) <> ("tracked_link_uses"."dm_id" is null)),
	CONSTRAINT "tracked_link_uses_token_check" CHECK (("tracked_link_uses"."token_hash" is null) = ("tracked_link_uses"."person_id" is null)),
	CONSTRAINT "tracked_link_uses_token_hash_check" CHECK ("tracked_link_uses"."token_hash" is null or "tracked_link_uses"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tracked_link_uses_dm_token_check" CHECK ("tracked_link_uses"."dm_id" is null or "tracked_link_uses"."token_hash" is null)
);
--> statement-breakpoint
CREATE TABLE "tracked_links" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"domain_id" uuid NOT NULL,
	"destination" text NOT NULL,
	"check_only" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tracked_links_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "tracked_links_destination_key" UNIQUE("workspace_id","campaign_id","step_key","domain_id","destination","check_only"),
	CONSTRAINT "tracked_links_id_check" CHECK ("tracked_links"."id" ~ '^[A-Za-z0-9_-]{22}$'),
	CONSTRAINT "tracked_links_destination_check" CHECK ("tracked_links"."destination" like 'https://%' and length("tracked_links"."destination") <= 2048)
);
--> statement-breakpoint
CREATE TABLE "tracking_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"txt_value" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"checked_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tracking_domains_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "tracking_domains_hostname_key" UNIQUE("hostname"),
	CONSTRAINT "tracking_domains_state_check" CHECK ("tracking_domains"."state" in ('pending', 'dns_ok', 'verified', 'stopped')),
	CONSTRAINT "tracking_domains_hostname_check" CHECK ("tracking_domains"."hostname" = lower("tracking_domains"."hostname") and "tracking_domains"."hostname" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' and length("tracking_domains"."hostname") <= 253)
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "tracking_domain_id" uuid;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "tracking_on" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "tracking_set_by" uuid;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "tracking_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "tracking_wording_version" integer;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "per_person_on" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "per_person_set_by" uuid;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "per_person_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "per_person_wording_version" integer;--> statement-breakpoint
ALTER TABLE "tracked_link_uses" ADD CONSTRAINT "tracked_link_uses_link_fk" FOREIGN KEY ("workspace_id","link_id") REFERENCES "public"."tracked_links"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_link_uses" ADD CONSTRAINT "tracked_link_uses_action_fk" FOREIGN KEY ("workspace_id","action_id") REFERENCES "public"."actions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_link_uses" ADD CONSTRAINT "tracked_link_uses_dm_fk" FOREIGN KEY ("workspace_id","dm_id") REFERENCES "public"."campaign_dms"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_link_uses" ADD CONSTRAINT "tracked_link_uses_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_campaign_fk" FOREIGN KEY ("workspace_id","campaign_id") REFERENCES "public"."campaigns"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_domain_fk" FOREIGN KEY ("workspace_id","domain_id") REFERENCES "public"."tracking_domains"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_domains" ADD CONSTRAINT "tracking_domains_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_domains" ADD CONSTRAINT "tracking_domains_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tracked_link_uses_action_idx" ON "tracked_link_uses" USING btree ("workspace_id","action_id");--> statement-breakpoint
CREATE INDEX "tracked_link_uses_link_idx" ON "tracked_link_uses" USING btree ("workspace_id","link_id");--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tracking_set_by_user_id_fk" FOREIGN KEY ("tracking_set_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_per_person_set_by_user_id_fk" FOREIGN KEY ("per_person_set_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tracking_check" CHECK (not "campaigns"."tracking_on" or ("campaigns"."tracking_domain_id" is not null and "campaigns"."tracking_set_by" is not null and "campaigns"."tracking_wording_version" is not null));--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_per_person_check" CHECK (not "campaigns"."per_person_on" or ("campaigns"."tracking_on" and "campaigns"."per_person_set_by" is not null and "campaigns"."per_person_wording_version" is not null));--> statement-breakpoint
-- The Campaign's tracking domain; in the migration, since schema-tracking imports schema-campaigns.
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tracking_domain_fk" FOREIGN KEY ("workspace_id","tracking_domain_id") REFERENCES "public"."tracking_domains"("workspace_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Forced RLS, same workspace policy as every Workspace table.
ALTER TABLE tracking_domains ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tracking_domains FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON tracking_domains
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE tracked_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tracked_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON tracked_links
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE tracked_link_uses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tracked_link_uses FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON tracked_link_uses
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- A link and its destination never change (ADR 0035 rule 004), and neither does a use, except when its
-- message goes out. A domain moves through its states and may be removed while unused
-- (rule 008).
REVOKE UPDATE, DELETE ON tracked_links FROM direx_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON tracked_link_uses FROM direx_app;
--> statement-breakpoint
GRANT UPDATE (sent_at) ON tracked_link_uses TO direx_app;
--> statement-breakpoint
REVOKE UPDATE ON tracking_domains FROM direx_app;
--> statement-breakpoint
GRANT UPDATE (state, checked_at) ON tracking_domains TO direx_app;
--> statement-breakpoint
-- Whether the edge may get a certificate for a host (ADR 0035 rules 007 and 021): a host whose DNS
-- records matched, in a live Workspace. Yes or no only.
CREATE FUNCTION system.tracking_host_allowed(host text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  allowed boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.tracking_domains d
    JOIN public.workspaces w ON w.id = d.workspace_id AND w.deleted_at IS NULL
    WHERE d.hostname = lower(host) AND d.state IN ('dns_ok', 'verified')) INTO allowed;
  IF allowed THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('tracking_host_allowed', 1);
  END IF;
  RETURN allowed;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.tracking_host_allowed(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.tracking_host_allowed(text) TO direx_app;
--> statement-breakpoint
-- The redirect's one look across Workspaces (ADR 0035 rule 021): the link on this host, and for a token
-- the use it names. Ids only; the app opens the Workspace to read the destination and count. A stopped
-- domain still resolves links already sent (rule 008).
CREATE FUNCTION system.tracking_link_lookup(host text, link text, token_hash text)
RETURNS TABLE (workspace_id uuid, link_id text, use_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY
    SELECT l.workspace_id, l.id, u.id FROM public.tracked_links l
    JOIN public.tracking_domains d ON d.workspace_id = l.workspace_id AND d.id = l.domain_id
    JOIN public.workspaces w ON w.id = l.workspace_id AND w.deleted_at IS NULL
    LEFT JOIN public.tracked_link_uses u ON tracking_link_lookup.token_hash IS NOT NULL
      AND u.token_hash = tracking_link_lookup.token_hash AND u.workspace_id = l.workspace_id AND u.link_id = l.id
    WHERE l.id = link AND d.hostname = lower(host) AND d.state IN ('dns_ok', 'verified', 'stopped')
      AND (tracking_link_lookup.token_hash IS NULL OR u.id IS NOT NULL);
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('tracking_link_lookup', found);
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.tracking_link_lookup(text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.tracking_link_lookup(text, text, text) TO direx_app;
