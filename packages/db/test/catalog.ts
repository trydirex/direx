// SPDX-License-Identifier: AGPL-3.0-only
import type pg from "pg";
import { COLUMN_WINDOWS, RETENTION, TENANT_CLASSES, type ColumnWindow, type Retention } from "../src/retention";

const USER_TABLES = `
  select c.oid, c.oid::regclass::text as name, n.nspname, c.relowner, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p') and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'`;

// The job queue and the migration journal hold no tenant data, so they skip -001 and -006.
const TENANT_TABLES = `
  select t.*, a.attnum as ws, a.attnotnull as ws_not_null
  from (${USER_TABLES}) t join pg_attribute a on a.attrelid = t.oid
  where t.nspname not in ('pgboss', 'drizzle') and a.attname = 'workspace_id' and not a.attisdropped`;

/** Returns one message per tenancy rule the catalog breaks; empty means clean. */
export async function catalogViolations(
  c: pg.Client,
  retention: Readonly<Record<string, Retention>> = RETENTION,
  columns: readonly ColumnWindow[] = COLUMN_WINDOWS,
): Promise<string[]> {
  const out: string[] = [];

  for (const t of (await c.query(TENANT_TABLES)).rows) {
    if (!t.ws_not_null) out.push(`forced-rls: table ${t.name} has a nullable workspace_id`);
    if (!t.relrowsecurity) out.push(`forced-rls: table ${t.name} has workspace_id but ROW LEVEL SECURITY is off`);
    if (!t.relforcerowsecurity)
      out.push(`forced-rls: table ${t.name} has workspace_id but FORCE ROW LEVEL SECURITY is off`);
  }

  const fks = await c.query(`
    with t as (${TENANT_TABLES})
    select f.conname, child.name as child, parent.name as parent
    from pg_constraint f
    join t child on child.oid = f.conrelid
    join t parent on parent.oid = f.confrelid
    where f.contype = 'f'
      and (array_position(f.conkey, child.ws) is null
        or array_position(f.conkey, child.ws) is distinct from array_position(f.confkey, parent.ws))`);
  for (const r of fks.rows)
    out.push(`workspace-fk: foreign key ${r.conname} from ${r.child} to ${r.parent} does not pair workspace_id on both sides`);

  const owned = await c.query(`select name from (${USER_TABLES}) t where t.relowner = 'direx_app'::regrole`);
  for (const r of owned.rows) out.push(`app-owns-table: table ${r.name} is owned by direx_app`);

  const granted = await c.query(`
    select name from (${USER_TABLES}) t
    where has_table_privilege('direx_system', t.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')`);
  for (const r of granted.rows) out.push(`system-role: direx_system holds a privilege on table ${r.name}`);

  const invokers = await c.query(`
    select p.oid::regprocedure::text as name from pg_proc p
    where p.pronamespace = 'system'::regnamespace and not p.prosecdef`);
  for (const r of invokers.rows) out.push(`system-role: function ${r.name} in schema system is not SECURITY DEFINER`);

  // ADR 0030 rule 003: only system.soft_delete_workspace sets the deletion time.
  const stamp = await c.query(`select has_column_privilege('direx_app', 'public.workspaces', 'deleted_at', 'UPDATE') as granted`);
  if (stamp.rows[0].granted) out.push("app-update: direx_app can UPDATE workspaces.deleted_at, which only system.soft_delete_workspace may set");
  // The app keeps table-wide INSERT (drizzle names every column), so a trigger refuses a row born deleted.
  const born = await c.query(
    `select 1 from pg_trigger where tgrelid = 'public.workspaces'::regclass and tgname = 'workspaces_insert_live' and tgenabled <> 'D'`,
  );
  if (!born.rowCount) out.push("app-insert: direx_app can INSERT a workspaces row with deleted_at set; the workspaces_insert_live trigger is gone");
  // Only the owner runs the purge.
  const purge = await c.query(`
    select p.oid::regprocedure::text as name from pg_proc p
    where p.pronamespace = 'system'::regnamespace and p.proname like 'purge%' and has_function_privilege('direx_app', p.oid, 'EXECUTE')`);
  for (const r of purge.rows) out.push(`app-purge: direx_app can EXECUTE ${r.name}, which only the owner may run`);

  out.push(...(await retentionViolations(c, retention, columns)));
  return out;
}

// Partitions belong to their parent's entry: pg-boss adds one per queue and per day.
const LISTED_TABLES = `
  select t.nspname || '.' || c.relname as name,
    exists (select 1 from pg_attribute a where a.attrelid = t.oid and a.attname = 'workspace_id' and not a.attisdropped) as tenant,
    has_table_privilege('direx_app', t.oid, 'DELETE') as app_deletes
  from (${USER_TABLES}) t join pg_class c on c.oid = t.oid
  where not c.relispartition`;

/** ADR 0030 rules 001 and 003: one entry per table, a class that fits it, and no DELETE the app lost. */
async function retentionViolations(c: pg.Client, retention: Readonly<Record<string, Retention>>, columns: readonly ColumnWindow[]): Promise<string[]> {
  const out: string[] = [];
  const tables = (await c.query(LISTED_TABLES)).rows as { name: string; tenant: boolean; app_deletes: boolean }[];
  const seen = new Set(tables.map((t) => t.name));
  for (const t of tables) {
    const entry = retention[t.name];
    if (!entry) {
      out.push(`retention: table ${t.name} has no entry in packages/db/src/retention.ts`);
      continue;
    }
    if (t.tenant && !TENANT_CLASSES.includes(entry.class))
      out.push(`retention: tenant table ${t.name} is listed as ${entry.class}, not audit, operational or suppression`);
    if (!t.tenant && TENANT_CLASSES.includes(entry.class)) out.push(`retention: table ${t.name} has no workspace_id but is listed as ${entry.class}`);
    if (t.app_deletes && !entry.appDeletes) out.push(`app-delete: direx_app holds DELETE on table ${t.name}, which the retention list says it may not`);
  }
  for (const name of Object.keys(retention)) if (!seen.has(name)) out.push(`retention: entry ${name} names no table`);
  // ADR 0030 rule 002: a sweep named in the list exists and deletes by the list's window, word for word.
  for (const [name, entry] of Object.entries(retention)) {
    if (entry.class !== "operational" || !entry.sweep.startsWith("system.")) continue;
    const fn = await c.query(`select prosrc from pg_proc where oid = to_regprocedure($1)`, [`${entry.sweep}(integer)`]);
    if (!fn.rowCount) out.push(`retention: ${name} names ${entry.sweep}, which is not a function of one integer`);
    else if (!fn.rows[0].prosrc.includes(`DELETE FROM public.${name.split(".")[1]} `) || !fn.rows[0].prosrc.includes(entry.window))
      out.push(`retention: ${entry.sweep} does not delete from ${name} by its window`);
  }
  for (const w of columns) {
    const [schema, table] = w.table.split(".");
    const found = await c.query(
      `select 1 from pg_attribute a join pg_class t on t.oid = a.attrelid join pg_namespace n on n.oid = t.relnamespace
       where n.nspname = $1 and t.relname = $2 and a.attname = $3 and not a.attisdropped`,
      [schema, table, w.column],
    );
    if (!found.rowCount) out.push(`retention: column window ${w.table}.${w.column} names no column`);
  }
  return out;
}
