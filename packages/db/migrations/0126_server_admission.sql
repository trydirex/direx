-- Who may sign up to a self-hosted server, its Server admins, and the bootstrap invite that makes
-- the first one (ADR 0024). The tables sit in schema system with no grants: direx_app reaches them
-- only through the SECURITY DEFINER functions below (DX-R-0024-010). The Server admin flag is a row
-- in system.server_admins, not a column on auth."user", because direx_app may update every auth
-- table. issue_bootstrap_invite and cli_grant_server_admin are executable by the owner only, which
-- is what `bun run server-admin` connects as (DX-R-0024-005, -009).
-- Errors: DX403 the actor is not a Server admin, DX404 not found or not usable, DXCLM the server
-- already has a Server admin, DXLST the last Server admin, DXUNV an unverified email,
-- DXDOM a malformed domain.
CREATE TABLE system.server_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  signup_policy text NOT NULL DEFAULT 'invite_only' CHECK (signup_policy IN ('invite_only', 'domains', 'anyone')),
  allowed_domains text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth."user" (id) ON DELETE SET NULL
);
--> statement-breakpoint
-- One row, Invite only, on every server, fresh or upgraded (ADR 0024: an upgrade makes nobody admin).
INSERT INTO system.server_settings DEFAULT VALUES;
--> statement-breakpoint
-- RESTRICT: an account can't be deleted while it is a Server admin, so the last one can't vanish.
CREATE TABLE system.server_admins (
  user_id uuid PRIMARY KEY REFERENCES auth."user" (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- The token is shown once by the CLI; only its SHA-256 is stored. At most 72 hours.
CREATE TABLE system.bootstrap_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES auth."user" (id) ON DELETE SET NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '72 hours')
);
--> statement-breakpoint
-- Every grant and removal, kept after the account is gone, so no foreign keys.
CREATE TABLE system.server_admin_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('grant', 'remove')),
  via text NOT NULL CHECK (via IN ('bootstrap', 'admin', 'cli')),
  by_user_id uuid,
  CHECK ((via = 'admin') = (by_user_id IS NOT NULL))
);
--> statement-breakpoint
CREATE FUNCTION system.is_server_admin(account uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT EXISTS (SELECT 1 FROM system.server_admins a WHERE a.user_id = account)
$$;
--> statement-breakpoint
CREATE FUNCTION system.server_status()
RETURNS TABLE (claimed boolean, signup_policy text, allowed_domains text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT EXISTS (SELECT 1 FROM system.server_admins), s.signup_policy, s.allowed_domains
  FROM system.server_settings s
$$;
--> statement-breakpoint
-- How an account may be admitted: 'bootstrap', 'invite', 'policy' or 'refused'. A Workspace invite
-- counts only for its own email, and is read as yes or no, never returned (ADR 0024, Tenancy).
-- Domains are compared exactly, on the lowercased part after the last @; the app sends punycode.
-- Email verification is the caller's check (DX-R-0024-002).
CREATE FUNCTION system.signup_admission(invitee_email text, invite_token_hash text)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  addr text := lower(btrim(invitee_email));
  addr_domain text := substring(lower(btrim(invitee_email)) FROM '@([^@]+)$');
  s record;
BEGIN
  IF invite_token_hash IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM system.server_admins) AND EXISTS (
      SELECT 1 FROM system.bootstrap_invites b
      WHERE b.token_hash = invite_token_hash AND b.accepted_at IS NULL AND b.revoked_at IS NULL AND b.expires_at > now()
    ) THEN
      RETURN 'bootstrap';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.workspace_invites i
      WHERE i.token_hash = invite_token_hash AND i.email = addr
        AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
    ) THEN
      RETURN 'invite';
    END IF;
  END IF;
  SELECT st.signup_policy, st.allowed_domains INTO s FROM system.server_settings st;
  IF s.signup_policy = 'anyone' THEN
    RETURN 'policy';
  END IF;
  IF s.signup_policy = 'domains' AND addr_domain IS NOT NULL AND addr_domain = ANY (s.allowed_domains) THEN
    RETURN 'policy';
  END IF;
  RETURN 'refused';
END
$$;
--> statement-breakpoint
-- Makes the claimant the first Server admin. The table lock serialises claims, so two at once
-- leave one admin (DX-R-0024-005).
CREATE FUNCTION system.claim_bootstrap(claimant uuid, invite_token_hash text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
  LOCK TABLE system.server_admins IN EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM system.server_admins) THEN
    RAISE EXCEPTION 'already_claimed' USING ERRCODE = 'DXCLM';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth."user" u WHERE u.id = claimant AND u.email_verified) THEN
    RAISE EXCEPTION 'unverified' USING ERRCODE = 'DXUNV';
  END IF;
  UPDATE system.bootstrap_invites b SET accepted_at = now(), accepted_by = claimant
  WHERE b.token_hash = invite_token_hash AND b.accepted_at IS NULL AND b.revoked_at IS NULL AND b.expires_at > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invite_not_usable' USING ERRCODE = 'DX404';
  END IF;
  INSERT INTO system.server_admins (user_id) VALUES (claimant);
  INSERT INTO system.server_admin_events (user_id, action, via) VALUES (claimant, 'grant', 'bootstrap');
END
$$;
--> statement-breakpoint
CREATE FUNCTION system.set_signup_policy(actor uuid, policy text, domains text[])
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  d text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM system.server_admins a WHERE a.user_id = actor) THEN
    RAISE EXCEPTION 'not_server_admin' USING ERRCODE = 'DX403';
  END IF;
  FOREACH d IN ARRAY coalesce(domains, '{}') LOOP
    IF d !~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$' THEN
      RAISE EXCEPTION 'bad_domain: %', d USING ERRCODE = 'DXDOM';
    END IF;
  END LOOP;
  UPDATE system.server_settings
  SET signup_policy = policy, allowed_domains = coalesce(domains, '{}'), updated_at = now(), updated_by = actor;
END
$$;
--> statement-breakpoint
-- Grants or removes Server admin for an existing account. The table lock serialises changes, so
-- two admins removing each other at once leave one (DX-R-0024-009).
CREATE FUNCTION system.set_server_admin(actor uuid, target uuid, make_admin boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
  LOCK TABLE system.server_admins IN EXCLUSIVE MODE;
  IF NOT EXISTS (SELECT 1 FROM system.server_admins a WHERE a.user_id = actor) THEN
    RAISE EXCEPTION 'not_server_admin' USING ERRCODE = 'DX403';
  END IF;
  IF make_admin THEN
    IF NOT EXISTS (SELECT 1 FROM auth."user" u WHERE u.id = target) THEN
      RAISE EXCEPTION 'no_account' USING ERRCODE = 'DX404';
    END IF;
    INSERT INTO system.server_admins (user_id) VALUES (target) ON CONFLICT DO NOTHING;
    IF FOUND THEN
      INSERT INTO system.server_admin_events (user_id, action, via, by_user_id) VALUES (target, 'grant', 'admin', actor);
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM system.server_admins a WHERE a.user_id = target) THEN
      RAISE EXCEPTION 'not_server_admin' USING ERRCODE = 'DX404';
    END IF;
    IF (SELECT count(*) FROM system.server_admins) <= 1 THEN
      RAISE EXCEPTION 'last_server_admin' USING ERRCODE = 'DXLST';
    END IF;
    DELETE FROM system.server_admins a WHERE a.user_id = target;
    INSERT INTO system.server_admin_events (user_id, action, via, by_user_id) VALUES (target, 'remove', 'admin', actor);
  END IF;
END
$$;
--> statement-breakpoint
-- Every account on the server, for its Server admins. Account fields only: no Workspace data
-- (DX-R-0024-007).
CREATE FUNCTION system.list_accounts(actor uuid)
RETURNS TABLE (user_id uuid, email text, email_verified boolean, created_at timestamptz, server_admin boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM system.server_admins a WHERE a.user_id = actor) THEN
    RAISE EXCEPTION 'not_server_admin' USING ERRCODE = 'DX403';
  END IF;
  RETURN QUERY
    SELECT u.id, u.email, u.email_verified, u.created_at,
      EXISTS (SELECT 1 FROM system.server_admins a WHERE a.user_id = u.id)
    FROM auth."user" u
    ORDER BY u.created_at, u.id;
END
$$;
--> statement-breakpoint
-- Owner only (the CLI). Refuses once the server is claimed; revokes every earlier unused invite.
CREATE FUNCTION system.issue_bootstrap_invite(invite_token_hash text, expires timestamptz)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
  LOCK TABLE system.server_admins IN EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM system.server_admins) THEN
    RAISE EXCEPTION 'already_claimed' USING ERRCODE = 'DXCLM';
  END IF;
  UPDATE system.bootstrap_invites b SET revoked_at = now()
  WHERE b.accepted_at IS NULL AND b.revoked_at IS NULL;
  INSERT INTO system.bootstrap_invites (token_hash, expires_at) VALUES (invite_token_hash, expires);
END
$$;
--> statement-breakpoint
-- Owner only (the CLI): makes an existing account Server admin, for when every admin is locked out.
CREATE FUNCTION system.cli_grant_server_admin(account_email text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  target uuid;
BEGIN
  SELECT u.id INTO target FROM auth."user" u WHERE lower(u.email) = lower(btrim(account_email));
  IF target IS NULL THEN
    RAISE EXCEPTION 'no_account' USING ERRCODE = 'DX404';
  END IF;
  LOCK TABLE system.server_admins IN EXCLUSIVE MODE;
  INSERT INTO system.server_admins (user_id) VALUES (target) ON CONFLICT DO NOTHING;
  IF FOUND THEN
    INSERT INTO system.server_admin_events (user_id, action, via) VALUES (target, 'grant', 'cli');
  END IF;
  RETURN target;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.is_server_admin(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.server_status() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.signup_admission(text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.claim_bootstrap(uuid, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.set_signup_policy(uuid, text, text[]) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.set_server_admin(uuid, uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.list_accounts(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.issue_bootstrap_invite(text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.cli_grant_server_admin(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.is_server_admin(uuid) TO direx_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.server_status() TO direx_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.signup_admission(text, text) TO direx_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.claim_bootstrap(uuid, text) TO direx_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.set_signup_policy(uuid, text, text[]) TO direx_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.set_server_admin(uuid, uuid, boolean) TO direx_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.list_accounts(uuid) TO direx_app;
