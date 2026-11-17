ALTER TABLE "workspaces" ADD COLUMN "purging_at" timestamp with time zone;
--> statement-breakpoint
-- ADR 0030 rules 003, 004 and 007: the Workspace purge. A Server admin runs it by command, as the
-- owner, 30 days or more after a soft delete. The app can call none of the purge_* functions.
--
-- Rule 003: a Workspace is inserted live. The app keeps table-wide INSERT, because drizzle names every
-- column, but no row may arrive already deleted or purging; only the system functions set those.
CREATE FUNCTION public.workspaces_insert_live()
RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'a Workspace is inserted live: deleted_at and purging_at are set by the system functions'
    USING ERRCODE = 'check_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER workspaces_insert_live BEFORE INSERT ON public.workspaces
  FOR EACH ROW WHEN (NEW.deleted_at IS NOT NULL OR NEW.purging_at IS NOT NULL)
  EXECUTE FUNCTION public.workspaces_insert_live();
--> statement-breakpoint
-- No app code deletes a Workspace, an Organization or a consent record. A Workspace goes by soft delete
-- and then the purge, which keeps its emptied row and its consent records (ADR 0030 Q3).
REVOKE DELETE ON public.workspaces, public.organizations, public.person_eligibility FROM direx_app;
--> statement-breakpoint
-- What each purge removed, kept past the Workspace and outside every sweep (rule 004). Counts only, no
-- content. One open receipt per Workspace at a time: a purge stopped half way resumes on it.
CREATE TABLE system.purge_receipts (
  id bigserial PRIMARY KEY,
  workspace uuid NOT NULL,
  actor text NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 200),
  replay boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT now(),
  files_removed integer,
  hashes_written integer,
  rows jsonb NOT NULL DEFAULT '{}',
  kept jsonb,
  finished_at timestamptz,
  outcome text CHECK (outcome = 'purged'),
  CHECK ((finished_at IS NULL) = (outcome IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX purge_receipts_open_idx ON system.purge_receipts (workspace) WHERE finished_at IS NULL;
--> statement-breakpoint
-- A purged Workspace's opt-outs (ADR 0030 Q6): HMAC-SHA256 of the lower-cased address under the vault
-- secret suppression.key, with the Organization, and nothing else. The send-time check of any Workspace
-- in the same Organization reads them through the two functions below; no other Organization can.
CREATE TABLE system.suppression_hashes (
  org_id uuid NOT NULL,
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, hash)
);
--> statement-breakpoint
-- withWorkspace asks this in the statement that sets the Workspace, and refuses a purging one.
CREATE FUNCTION system.workspace_purging(p_workspace uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = p_workspace AND w.purging_at IS NOT NULL)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.workspace_purging(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.workspace_purging(uuid) TO direx_app;
--> statement-breakpoint
CREATE FUNCTION system.hashed_opt_outs_exist()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM system.suppression_hashes h JOIN public.workspaces w ON w.org_id = h.org_id
    WHERE w.id = nullif(current_setting('app.workspace_id', true), '')::uuid)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.hashed_opt_outs_exist() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.hashed_opt_outs_exist() TO direx_app;
--> statement-breakpoint
CREATE FUNCTION system.hashed_opt_out(p_hashes text[])
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM system.suppression_hashes h JOIN public.workspaces w ON w.org_id = h.org_id
    WHERE w.id = nullif(current_setting('app.workspace_id', true), '')::uuid AND h.hash = ANY (p_hashes))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.hashed_opt_out(text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.hashed_opt_out(text[]) TO direx_app;
--> statement-breakpoint
-- Why a Workspace may not be purged, or null. The system Workspace never; a purged one not again; a live
-- one, one deleted under 30 days ago, or one with any Action not sent, blocked or cancelled (an unknown
-- outcome is held, so it counts) not yet. A replay after a restore skips live, recent and in_flight.
CREATE FUNCTION system.purge_refusal(p_workspace uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_deleted timestamptz;
BEGIN
  IF p_workspace = '00000000-0000-4000-8000-00000000d1e0'::uuid THEN
    RETURN 'system';
  END IF;
  SELECT w.deleted_at INTO v_deleted FROM public.workspaces w WHERE w.id = p_workspace;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF EXISTS (SELECT 1 FROM system.purge_receipts r WHERE r.workspace = p_workspace AND r.outcome = 'purged') THEN
    RETURN 'purged';
  END IF;
  IF v_deleted IS NULL THEN
    RETURN 'live';
  END IF;
  IF v_deleted > now() - interval '30 days' THEN
    RETURN 'recent';
  END IF;
  IF EXISTS (SELECT 1 FROM public.actions a WHERE a.workspace_id = p_workspace AND a.state NOT IN ('sent', 'blocked', 'cancelled')) THEN
    RETURN 'in_flight';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.purge_refusal(uuid) FROM PUBLIC;
--> statement-breakpoint
-- The open receipt, locked, once the refusal checks pass; a refusal raises DXPRG with its reason as message.
CREATE FUNCTION system.purge_open(p_workspace uuid)
RETURNS system.purge_receipts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  r system.purge_receipts;
  v_why text;
BEGIN
  SELECT * INTO r FROM system.purge_receipts x WHERE x.workspace = p_workspace AND x.finished_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'DXPRG', MESSAGE = 'not_purging';
  END IF;
  v_why := system.purge_refusal(p_workspace);
  IF v_why IS NOT NULL AND NOT (r.replay AND v_why IN ('live', 'recent', 'in_flight')) THEN
    RAISE EXCEPTION USING ERRCODE = 'DXPRG', MESSAGE = v_why;
  END IF;
  RETURN r;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.purge_open(uuid) FROM PUBLIC;
--> statement-breakpoint
-- Starts a purge, or returns the open one so a stopped purge resumes. Marks the Workspace purging, which
-- withWorkspace refuses from then on, and never clears the mark.
CREATE FUNCTION system.purge_start(p_workspace uuid, p_actor text, p_replay boolean)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_id bigint;
  v_why text;
BEGIN
  PERFORM 1 FROM public.workspaces w WHERE w.id = p_workspace FOR UPDATE;
  SELECT r.id INTO v_id FROM system.purge_receipts r WHERE r.workspace = p_workspace AND r.finished_at IS NULL;
  IF FOUND THEN
    PERFORM system.purge_open(p_workspace);
    RETURN v_id;
  END IF;
  v_why := system.purge_refusal(p_workspace);
  IF v_why IS NOT NULL AND NOT (p_replay AND v_why IN ('live', 'recent', 'in_flight')) THEN
    RAISE EXCEPTION USING ERRCODE = 'DXPRG', MESSAGE = v_why;
  END IF;
  UPDATE public.workspaces w SET purging_at = coalesce(w.purging_at, now()), deleted_at = coalesce(w.deleted_at, now())
    WHERE w.id = p_workspace;
  INSERT INTO system.purge_receipts (workspace, actor, replay) VALUES (p_workspace, p_actor, p_replay) RETURNING id INTO v_id;
  INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('purge_start', 1);
  RETURN v_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.purge_start(uuid, text, boolean) FROM PUBLIC;
--> statement-breakpoint
-- Records that the Workspace's media files and export ZIPs are gone from storage; their rows may go after.
CREATE FUNCTION system.purge_files_removed(p_workspace uuid, p_count integer)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  r system.purge_receipts;
BEGIN
  r := system.purge_open(p_workspace);
  UPDATE system.purge_receipts SET files_removed = p_count WHERE id = r.id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.purge_files_removed(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
-- Writes the Workspace's opt-outs as keyed hashes, at least one per suppression row; its suppression
-- rows may go after.
CREATE FUNCTION system.purge_write_hashes(p_workspace uuid, p_hashes text[])
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  r system.purge_receipts;
  v_count integer;
BEGIN
  r := system.purge_open(p_workspace);
  SELECT count(DISTINCT h) INTO v_count FROM unnest(p_hashes) h;
  IF v_count < (SELECT count(*) FROM public.suppressions s WHERE s.workspace_id = p_workspace) THEN
    RAISE EXCEPTION 'system.purge_write_hashes: fewer hashes than suppressions';
  END IF;
  INSERT INTO system.suppression_hashes (org_id, hash)
    SELECT w.org_id, h FROM public.workspaces w CROSS JOIN unnest(p_hashes) h WHERE w.id = p_workspace
    ON CONFLICT DO NOTHING;
  UPDATE system.purge_receipts SET hashes_written = v_count WHERE id = r.id;
  RETURN v_count;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.purge_write_hashes(uuid, text[]) FROM PUBLIC;
--> statement-breakpoint
-- Deletes at most p_limit of the Workspace's rows from one table, or its pg-boss jobs. Never a Q3
-- holdout (actions, approvals, action_events, person_eligibility) or the workspaces row. A row another
-- table still references stays: the purge goes children first, so what is left references only kept
-- rows, such as the credential a kept Action names. No foreign key cascades, so the count is exact. A
-- table that references itself goes in one statement, keeping the rows its kept rows reference.
CREATE FUNCTION system.purge_workspace_batch(p_workspace uuid, p_table text, p_limit integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  r system.purge_receipts;
  v_rel regclass;
  v_guard text;
  v_self text;
  v_found integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'system.purge_workspace_batch: limit must be 1 to 10000';
  END IF;
  r := system.purge_open(p_workspace);
  IF p_table = 'pgboss.job' THEN
    -- Every job names its Workspace as workspaceId, except an export build, which names it as exportOf.
    DELETE FROM pgboss.job j WHERE (j.name, j.id) IN (
      SELECT x.name, x.id FROM pgboss.job x
      WHERE x.data->>'workspaceId' = p_workspace::text OR (x.name = 'retention.export' AND x.data->>'exportOf' = p_workspace::text)
      LIMIT p_limit);
  ELSE
    v_rel := to_regclass(p_table);
    IF v_rel IS NULL OR p_table !~ '^public\.[a-z0-9_]+$'
      OR p_table IN ('public.actions', 'public.approvals', 'public.action_events', 'public.person_eligibility', 'public.workspaces')
      OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = v_rel AND a.attname = 'workspace_id' AND NOT a.attisdropped) THEN
      RAISE EXCEPTION 'system.purge_workspace_batch: the purge does not empty %', p_table;
    END IF;
    IF p_table IN ('public.media', 'public.workspace_exports') AND r.files_removed IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DXPRG', MESSAGE = 'files_first';
    END IF;
    IF p_table = 'public.suppressions' AND r.hashes_written IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DXPRG', MESSAGE = 'hashes_first';
    END IF;
    SELECT coalesce(string_agg(format(' AND NOT EXISTS (SELECT 1 FROM %s c WHERE %s)', c.conrelid::regclass, (
      SELECT string_agg(format('c.%I = t.%I', ca.attname, pa.attname), ' AND ')
      FROM unnest(c.conkey, c.confkey) k(ck, pk)
      JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = k.ck
      JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = k.pk)), ''), '')
      INTO v_guard
      FROM pg_constraint c WHERE c.contype = 'f' AND c.confrelid = v_rel AND c.conrelid <> v_rel;
    SELECT string_agg('(' || (
      SELECT string_agg(format('p.%I = c.%I', pa.attname, ca.attname), ' AND ')
      FROM unnest(c.conkey, c.confkey) k(ck, pk)
      JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = k.ck
      JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = k.pk) || ')', ' OR ')
      INTO v_self
      FROM pg_constraint c WHERE c.contype = 'f' AND c.confrelid = v_rel AND c.conrelid = v_rel;
    IF v_self IS NULL THEN
      EXECUTE format('DELETE FROM %1$s t WHERE t.ctid = ANY (ARRAY(SELECT t.ctid FROM %1$s t WHERE t.workspace_id = $1%2$s LIMIT $2))', v_rel, v_guard)
        USING p_workspace, p_limit;
    ELSE
      -- ponytail: a self-referencing table goes in one statement whatever its size; batch by depth if one grows large.
      EXECUTE format('WITH RECURSIVE keep(id) AS ('
        || 'SELECT t.ctid FROM %1$s t WHERE t.workspace_id = $1 AND NOT (true%2$s) '
        || 'UNION SELECT p.ctid FROM keep k JOIN %1$s c ON c.ctid = k.id JOIN %1$s p ON p.workspace_id = $1 AND (%3$s)) '
        || 'DELETE FROM %1$s t WHERE t.workspace_id = $1 AND t.ctid NOT IN (SELECT id FROM keep)', v_rel, v_guard, v_self)
        USING p_workspace;
    END IF;
  END IF;
  GET DIAGNOSTICS v_found = ROW_COUNT;
  -- A credential a kept Action names stays, without its secret.
  IF p_table = 'public.credentials' THEN
    UPDATE public.credentials SET ciphertext = NULL, nonce = NULL, deleted_at = coalesce(deleted_at, now())
      WHERE workspace_id = p_workspace AND ciphertext IS NOT NULL;
  END IF;
  IF v_found > 0 THEN
    UPDATE system.purge_receipts SET rows = jsonb_set(rows, ARRAY[p_table], to_jsonb(coalesce((rows->>p_table)::bigint, 0) + v_found))
      WHERE id = r.id;
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('purge_workspace_batch', v_found);
  END IF;
  RETURN v_found;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.purge_workspace_batch(uuid, text, integer) FROM PUBLIC;
--> statement-breakpoint
-- Closes the receipt once files and hashes are done: counts the rows left per table (the Q3 holdouts, the
-- emptied workspaces row and anything they reference) and blanks the Workspace's name.
CREATE FUNCTION system.purge_finish(p_workspace uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  r system.purge_receipts;
  v_kept jsonb := '{}';
  v_rel regclass;
  v_count bigint;
  v_out jsonb;
BEGIN
  r := system.purge_open(p_workspace);
  IF r.files_removed IS NULL OR r.hashes_written IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DXPRG', MESSAGE = 'steps_missing';
  END IF;
  FOR v_rel IN
    SELECT c.oid::regclass FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped)
    ORDER BY 1
  LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE workspace_id = $1', v_rel) INTO v_count USING p_workspace;
    IF v_count > 0 THEN
      v_kept := v_kept || jsonb_build_object(v_rel::text, v_count);
    END IF;
  END LOOP;
  UPDATE public.workspaces SET name = '' WHERE id = p_workspace;
  UPDATE system.purge_receipts SET kept = v_kept, finished_at = now(), outcome = 'purged' WHERE id = r.id;
  SELECT to_jsonb(x) INTO v_out FROM system.purge_receipts x WHERE x.id = r.id;
  INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('purge_finish', 1);
  RETURN v_out;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.purge_finish(uuid) FROM PUBLIC;
