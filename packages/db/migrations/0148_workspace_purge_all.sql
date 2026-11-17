-- ADR 0030 Q3 answered (2026-11-16, research note r75): the purge now deletes every row of the Workspace,
-- the ledger (actions, approvals, action_events), the consent records, the People and the rows they
-- referenced included, and then the workspaces row. It keeps the receipt and the suppression hashes,
-- which carry the Organization id as a plain value. When the purged Workspace was the last of its
-- Organization, the Organization row goes too (Q5), unless another table still references it.
-- direx_app still deletes none of these: only these owner-side definers do.
--
-- A purged Workspace has no row left, so a purge receipt answers "purged" before "not_found".
CREATE OR REPLACE FUNCTION system.purge_refusal(p_workspace uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_deleted timestamptz;
BEGIN
  IF p_workspace = '00000000-0000-4000-8000-00000000d1e0'::uuid THEN
    RETURN 'system';
  END IF;
  IF EXISTS (SELECT 1 FROM system.purge_receipts r WHERE r.workspace = p_workspace AND r.outcome = 'purged') THEN
    RETURN 'purged';
  END IF;
  SELECT w.deleted_at INTO v_deleted FROM public.workspaces w WHERE w.id = p_workspace;
  IF NOT FOUND THEN
    RETURN 'not_found';
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
-- Deletes at most p_limit of the Workspace's rows from one table, or its pg-boss jobs. Never the
-- workspaces row, which purge_finish removes. A row another table still references stays: the purge goes
-- children first, so a row is left only when something outside the Workspace references it. No foreign
-- key cascades, so the count is exact. A table that references itself goes in one statement, keeping the
-- rows its kept rows reference.
CREATE OR REPLACE FUNCTION system.purge_workspace_batch(p_workspace uuid, p_table text, p_limit integer)
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
    IF v_rel IS NULL OR p_table !~ '^public\.[a-z0-9_]+$' OR p_table = 'public.workspaces'
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
  -- A credential something outside the Workspace still references stays, without its secret.
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
-- Closes the receipt once files and hashes are done. With no row of the Workspace left in any table, it
-- deletes the workspaces row, and then the Organization row if no Workspace and no other row references
-- it; else it keeps that row and `kept` names the table that references it. If some row is left (only
-- something outside the Workspace can keep one), it keeps the workspaces row with its name blanked, and
-- `kept` holds the rows left per table. For a normal purge `kept` is empty.
CREATE OR REPLACE FUNCTION system.purge_finish(p_workspace uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  r system.purge_receipts;
  v_kept jsonb := '{}';
  v_rows jsonb := '{}';
  v_rel regclass;
  v_count bigint;
  v_org uuid;
  v_cond text;
  v_found boolean;
  v_out jsonb;
BEGIN
  r := system.purge_open(p_workspace);
  IF r.files_removed IS NULL OR r.hashes_written IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DXPRG', MESSAGE = 'steps_missing';
  END IF;
  FOR v_rel IN
    SELECT c.oid::regclass FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND c.oid <> 'public.workspaces'::regclass
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped)
    ORDER BY 1
  LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE workspace_id = $1', v_rel) INTO v_count USING p_workspace;
    IF v_count > 0 THEN
      v_kept := v_kept || jsonb_build_object(v_rel::text, v_count);
    END IF;
  END LOOP;
  IF v_kept = '{}' THEN
    DELETE FROM public.workspaces w WHERE w.id = p_workspace RETURNING w.org_id INTO v_org;
    v_rows := jsonb_build_object('public.workspaces', 1);
    IF NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.org_id = v_org) THEN
      -- Whatever else references the Organization, read from the catalogue, so a later table blocks it too.
      FOR v_rel, v_cond IN
        SELECT c.conrelid::regclass, (
          SELECT string_agg(format('c.%I = o.%I', ca.attname, pa.attname), ' AND ')
          FROM unnest(c.conkey, c.confkey) k(ck, pk)
          JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = k.ck
          JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = k.pk)
        FROM pg_constraint c WHERE c.contype = 'f' AND c.confrelid = 'public.organizations'::regclass
        ORDER BY 1
      LOOP
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s c JOIN public.organizations o ON %s WHERE o.id = $1)', v_rel, v_cond) INTO v_found USING v_org;
        IF v_found THEN
          v_kept := jsonb_build_object('public.organizations', 'referenced by ' || v_rel::text);
          EXIT;
        END IF;
      END LOOP;
      IF v_kept = '{}' THEN
        DELETE FROM public.organizations o WHERE o.id = v_org;
        v_rows := v_rows || jsonb_build_object('public.organizations', 1);
      END IF;
    END IF;
  ELSE
    UPDATE public.workspaces SET name = '' WHERE id = p_workspace;
    v_kept := v_kept || jsonb_build_object('public.workspaces', 1);
  END IF;
  UPDATE system.purge_receipts SET rows = rows || v_rows, kept = v_kept, finished_at = now(), outcome = 'purged' WHERE id = r.id;
  SELECT to_jsonb(x) INTO v_out FROM system.purge_receipts x WHERE x.id = r.id;
  INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('purge_finish', 1);
  RETURN v_out;
END
$$;
