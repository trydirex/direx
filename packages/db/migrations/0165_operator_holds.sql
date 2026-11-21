-- Operator holds: whoever runs this server stops one Workspace, one Organization or the whole
-- deployment from sending, and no member can lift it. The Dispatcher reads the live hold under the
-- Action's row lock, before any key is fetched or plugin called, and holds the Action as
-- operator_hold. Lifting re-checks what it held. The table sits in schema system with no grants:
-- direx_app reads a Workspace's hold and releases lifted ones only through the definers below, and
-- setting or lifting one is for the owner, which is what `bun run server-admin` connects as. Rows
-- are never deleted, so the table is the record of every hold and lift.
-- Errors: DX404 no such Organization or Workspace.
CREATE TABLE system.operator_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('deployment', 'organization', 'workspace')),
  target uuid,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  set_by text NOT NULL CHECK (length(btrim(set_by)) BETWEEN 1 AND 200),
  set_at timestamptz NOT NULL DEFAULT now(),
  lifted_by text CHECK (length(btrim(lifted_by)) BETWEEN 1 AND 200),
  lifted_at timestamptz,
  -- When the worker resumed what the lifted hold held.
  released_at timestamptz,
  CHECK ((scope = 'deployment') = (target IS NULL)),
  CHECK ((lifted_at IS NULL) = (lifted_by IS NULL)),
  CHECK (released_at IS NULL OR lifted_at IS NOT NULL)
);
--> statement-breakpoint
-- One live hold per target, so setting it twice changes nothing.
CREATE UNIQUE INDEX operator_holds_live_idx ON system.operator_holds (scope, coalesce(target, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE lifted_at IS NULL;
--> statement-breakpoint
CREATE INDEX operator_holds_unreleased_idx ON system.operator_holds (lifted_at) WHERE lifted_at IS NOT NULL AND released_at IS NULL;
--> statement-breakpoint
-- The scope of the oldest live hold on this Workspace, its Organization or the deployment, or null.
-- The operator's reason stays out: it can be an internal note, and the Workspace sees what it reads.
CREATE FUNCTION system.operator_hold_of(p_workspace uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT h.scope FROM system.operator_holds h
  WHERE h.lifted_at IS NULL
    AND (h.scope = 'deployment'
      OR (h.scope = 'workspace' AND h.target = p_workspace)
      OR (h.scope = 'organization' AND h.target = (SELECT w.org_id FROM public.workspaces w WHERE w.id = p_workspace)))
  ORDER BY h.set_at
  LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.operator_hold_of(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.operator_hold_of(uuid) TO direx_app;
--> statement-breakpoint
-- Lifted holds not yet released, each with the live Workspaces it covered that no other hold still
-- stops, or with null when it covers no live Workspace. A hold whose Workspaces are all stopped by
-- another hold isn't listed until that one is lifted too. Ids only.
CREATE FUNCTION system.operator_holds_to_release()
RETURNS TABLE (hold_id uuid, workspace_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  found integer;
BEGIN
  RETURN QUERY
    SELECT h.id, w.id FROM system.operator_holds h
    LEFT JOIN public.workspaces w ON w.deleted_at IS NULL AND w.purging_at IS NULL
      AND (h.scope = 'deployment' OR (h.scope = 'organization' AND w.org_id = h.target) OR (h.scope = 'workspace' AND w.id = h.target))
    WHERE h.lifted_at IS NOT NULL AND h.released_at IS NULL
      AND (w.id IS NULL OR system.operator_hold_of(w.id) IS NULL);
  GET DIAGNOSTICS found = ROW_COUNT;
  IF found > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('operator_holds_to_release', found);
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.operator_holds_to_release() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.operator_holds_to_release() TO direx_app;
--> statement-breakpoint
-- Called once what operator_holds_to_release listed for these holds has been resumed.
CREATE FUNCTION system.mark_operator_holds_released(p_holds uuid[])
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $$
  UPDATE system.operator_holds h SET released_at = now() WHERE h.id = ANY (p_holds) AND h.lifted_at IS NOT NULL AND h.released_at IS NULL
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.mark_operator_holds_released(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.mark_operator_holds_released(uuid[]) TO direx_app;
--> statement-breakpoint
-- Sets a live hold, or returns null when one is live on that target already. Owner only.
CREATE FUNCTION system.set_operator_hold(p_scope text, p_target uuid, p_reason text, p_by text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  made uuid;
BEGIN
  IF (p_scope = 'organization' AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_target))
    OR (p_scope = 'workspace' AND NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = p_target)) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'DX404';
  END IF;
  INSERT INTO system.operator_holds (scope, target, reason, set_by) VALUES (p_scope, p_target, p_reason, p_by)
  ON CONFLICT DO NOTHING
  RETURNING id INTO made;
  RETURN made;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.set_operator_hold(text, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
-- Lifts the live hold on a target; false when there is none. Owner only.
CREATE FUNCTION system.lift_operator_hold(p_scope text, p_target uuid, p_by text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE system.operator_holds h SET lifted_at = now(), lifted_by = p_by
  WHERE h.lifted_at IS NULL AND h.scope = p_scope AND h.target IS NOT DISTINCT FROM p_target;
  RETURN FOUND;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.lift_operator_hold(text, uuid, text) FROM PUBLIC;
