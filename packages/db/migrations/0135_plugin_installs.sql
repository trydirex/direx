CREATE TABLE "workspace_plugins" (
	"workspace_id" uuid NOT NULL,
	"plugin_id" text NOT NULL,
	"install_id" uuid NOT NULL,
	"permission_hash" text NOT NULL,
	"enabled_by" uuid NOT NULL,
	"enabled_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workspace_plugins_pkey" PRIMARY KEY("workspace_id","plugin_id"),
	CONSTRAINT "workspace_plugins_hash_check" CHECK ("workspace_plugins"."permission_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "workspace_plugins" ADD CONSTRAINT "workspace_plugins_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_plugins" ADD CONSTRAINT "workspace_plugins_enabled_by_user_id_fk" FOREIGN KEY ("enabled_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Third-party plugin installs (ADR 0026). Installs are server-wide and made only by a Server admin
-- (rule 001): system tables with no grants, reached through the SECURITY DEFINER functions below.
-- A Workspace owner's turn-on (workspace_plugins, forced RLS) counts only while its install_id and
-- permission_hash match the install (rule 002), so a remove needs no write into any Workspace.
-- Errors: DX403 the actor is not a Server admin, DX404 not installed, DXINS already installed,
-- DXARG a bad argument.
ALTER TABLE workspace_plugins ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_plugins FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON workspace_plugins
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE SEQUENCE system.plugin_generation;
--> statement-breakpoint
CREATE TABLE system.plugin_installs (
  plugin_id text PRIMARY KEY CHECK (plugin_id ~ '^[a-z0-9]+(\.[a-z0-9-]+)+$'),
  install_id uuid NOT NULL UNIQUE,
  version text NOT NULL,
  manifest jsonb NOT NULL,
  permission_hash text NOT NULL CHECK (permission_hash ~ '^[0-9a-f]{64}$'),
  entry_sha256 text NOT NULL CHECK (entry_sha256 ~ '^[0-9a-f]{64}$'),
  generation bigint NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Every install, upgrade and removal, kept after the plugin and the account are gone, so no foreign keys.
CREATE TABLE system.plugin_install_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  plugin_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('install', 'upgrade', 'remove')),
  version text,
  entry_sha256 text,
  permission_hash text,
  generation bigint NOT NULL,
  via text NOT NULL CHECK (via IN ('web', 'cli')),
  by_user_id uuid,
  CHECK ((via = 'web') = (by_user_id IS NOT NULL))
);
--> statement-breakpoint
CREATE FUNCTION system.put_plugin_install(
  actor uuid, via text, mode text, p_plugin_id text, p_version text, p_manifest jsonb, p_permission_hash text, p_entry_sha256 text
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  gen bigint;
  inst uuid;
BEGIN
  IF via = 'web' AND NOT EXISTS (SELECT 1 FROM system.server_admins a WHERE a.user_id = actor) THEN
    RAISE EXCEPTION 'not_server_admin' USING ERRCODE = 'DX403';
  END IF;
  IF p_manifest ->> 'id' IS DISTINCT FROM p_plugin_id OR p_manifest ->> 'version' IS DISTINCT FROM p_version THEN
    RAISE EXCEPTION 'manifest_mismatch' USING ERRCODE = 'DXARG';
  END IF;
  gen := nextval('system.plugin_generation');
  SELECT i.install_id INTO inst FROM system.plugin_installs i WHERE i.plugin_id = p_plugin_id FOR UPDATE;
  IF mode = 'install' THEN
    IF FOUND THEN
      RAISE EXCEPTION 'already_installed' USING ERRCODE = 'DXINS';
    END IF;
    inst := gen_random_uuid();
    INSERT INTO system.plugin_installs (plugin_id, install_id, version, manifest, permission_hash, entry_sha256, generation)
    VALUES (p_plugin_id, inst, p_version, p_manifest, p_permission_hash, p_entry_sha256, gen);
  ELSIF mode = 'upgrade' THEN
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_installed' USING ERRCODE = 'DX404';
    END IF;
    UPDATE system.plugin_installs i
    SET version = p_version, manifest = p_manifest, permission_hash = p_permission_hash, entry_sha256 = p_entry_sha256,
        generation = gen, updated_at = now()
    WHERE i.plugin_id = p_plugin_id;
  ELSE
    RAISE EXCEPTION 'bad_mode: %', mode USING ERRCODE = 'DXARG';
  END IF;
  INSERT INTO system.plugin_install_events (plugin_id, action, version, entry_sha256, permission_hash, generation, via, by_user_id)
  VALUES (p_plugin_id, mode, p_version, p_entry_sha256, p_permission_hash, gen, via, CASE WHEN via = 'web' THEN actor END);
  -- Every API and worker process listens, reloads its plugin list and stops stale processes (rule 004).
  PERFORM pg_notify('plugins', gen::text);
  RETURN inst;
END
$$;
--> statement-breakpoint
CREATE FUNCTION system.drop_plugin_install(actor uuid, via text, p_plugin_id text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  gen bigint;
BEGIN
  IF via = 'web' AND NOT EXISTS (SELECT 1 FROM system.server_admins a WHERE a.user_id = actor) THEN
    RAISE EXCEPTION 'not_server_admin' USING ERRCODE = 'DX403';
  END IF;
  DELETE FROM system.plugin_installs i WHERE i.plugin_id = p_plugin_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_installed' USING ERRCODE = 'DX404';
  END IF;
  gen := nextval('system.plugin_generation');
  INSERT INTO system.plugin_install_events (plugin_id, action, generation, via, by_user_id)
  VALUES (p_plugin_id, 'remove', gen, via, CASE WHEN via = 'web' THEN actor END);
  PERFORM pg_notify('plugins', gen::text);
END
$$;
--> statement-breakpoint
-- The web app's calls: the actor must be a Server admin.
CREATE FUNCTION system.install_plugin(
  actor uuid, mode text, p_plugin_id text, p_version text, p_manifest jsonb, p_permission_hash text, p_entry_sha256 text
)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $$ SELECT system.put_plugin_install(actor, 'web', mode, p_plugin_id, p_version, p_manifest, p_permission_hash, p_entry_sha256) $$;
--> statement-breakpoint
CREATE FUNCTION system.remove_plugin(actor uuid, p_plugin_id text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $$ SELECT system.drop_plugin_install(actor, 'web', p_plugin_id) $$;
--> statement-breakpoint
-- `bun run plugin`'s calls: executable by the owner only, so this server's shell is the proof.
CREATE FUNCTION system.cli_install_plugin(
  mode text, p_plugin_id text, p_version text, p_manifest jsonb, p_permission_hash text, p_entry_sha256 text
)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $$ SELECT system.put_plugin_install(NULL, 'cli', mode, p_plugin_id, p_version, p_manifest, p_permission_hash, p_entry_sha256) $$;
--> statement-breakpoint
CREATE FUNCTION system.cli_remove_plugin(p_plugin_id text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $$ SELECT system.drop_plugin_install(NULL, 'cli', p_plugin_id) $$;
--> statement-breakpoint
-- What every process loads: the installed list. Manifests and hashes only; nothing secret.
CREATE FUNCTION system.installed_plugins()
RETURNS TABLE (plugin_id text, install_id uuid, version text, manifest jsonb, permission_hash text, entry_sha256 text, generation bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT i.plugin_id, i.install_id, i.version, i.manifest, i.permission_hash, i.entry_sha256, i.generation
  FROM system.plugin_installs i ORDER BY i.plugin_id
$$;
--> statement-breakpoint
-- The call gate (rule 002): the current Workspace has this plugin on, for the install and
-- permissions that exist now. False when no Workspace is set.
CREATE FUNCTION system.plugin_turned_on(p_plugin_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_plugins w
    JOIN system.plugin_installs i ON i.plugin_id = w.plugin_id AND i.install_id = w.install_id AND i.permission_hash = w.permission_hash
    WHERE w.plugin_id = p_plugin_id
      AND w.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.put_plugin_install(uuid, text, text, text, text, jsonb, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.drop_plugin_install(uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.install_plugin(uuid, text, text, text, jsonb, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.remove_plugin(uuid, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.cli_install_plugin(text, text, text, jsonb, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.cli_remove_plugin(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.installed_plugins() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.plugin_turned_on(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.install_plugin(uuid, text, text, text, jsonb, text, text) TO direx_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.remove_plugin(uuid, text) TO direx_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.installed_plugins() TO direx_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.plugin_turned_on(text) TO direx_app;
