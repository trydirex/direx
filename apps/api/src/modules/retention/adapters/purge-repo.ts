// SPDX-License-Identifier: AGPL-3.0-only
// The purge's reads and calls, over the owner's connection (ADR 0030 rule 003): only the owner may run
// the system.purge_* functions, and it reads across Workspaces because it bypasses row-level security.
// The Server admin's command brings the connection; nothing in the app holds one.
import type { Edge } from "../domain/purge";

export type OwnerDb = { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

/** A refusal from the purge's definers, by reason: system, not_found, purged, live, recent, in_flight. */
export class PurgeRefused extends Error {
  constructor(readonly reason: string) {
    super(`purge refused: ${reason}`);
  }
}

async function call(db: OwnerDb, text: string, params: unknown[]): Promise<Record<string, unknown>> {
  try {
    return (await db.query(text, params)).rows[0]!;
  } catch (e) {
    if ((e as { code?: string }).code === "DXPRG") throw new PurgeRefused((e as Error).message);
    throw e;
  }
}

export const refusal = async (db: OwnerDb, ws: string) => (await call(db, "select system.purge_refusal($1) as why", [ws])).why as string | null;

/** Every table that holds a Workspace's rows, read from the migrated catalogue, schema-qualified. */
export async function tenantTables(db: OwnerDb): Promise<string[]> {
  const { rows } = await db.query(
    `select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
       and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'workspace_id' and not a.attisdropped)
     order by 1`,
  );
  return rows.map((r) => r.name as string);
}

export async function foreignKeys(db: OwnerDb): Promise<Edge[]> {
  const { rows } = await db.query(
    `select cn.nspname || '.' || cc.relname as child, pn.nspname || '.' || pc.relname as parent
     from pg_constraint f
     join pg_class cc on cc.oid = f.conrelid join pg_namespace cn on cn.oid = cc.relnamespace
     join pg_class pc on pc.oid = f.confrelid join pg_namespace pn on pn.oid = pc.relnamespace
     where f.contype = 'f'`,
  );
  return rows as Edge[];
}

/** The Workspace's rows per table, leaving out empty tables. */
export async function rowCounts(db: OwnerDb, ws: string, tables: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    const n = Number((await db.query(`select count(*) as n from ${t} where workspace_id = $1`, [ws])).rows[0]!.n);
    if (n > 0) out[t] = n;
  }
  return out;
}

/** Whether the Workspace is the only one left in its Organization. */
export async function lastOfOrganization(db: OwnerDb, ws: string): Promise<boolean> {
  const { rows } = await db.query("select count(*) as n from public.workspaces o join public.workspaces w on w.org_id = o.org_id where o.id = $1", [ws]);
  return Number(rows[0]!.n) === 1;
}

export async function jobCount(db: OwnerDb, ws: string): Promise<number> {
  const { rows } = await db.query(
    `select count(*) as n from pgboss.job where data->>'workspaceId' = $1 or (name = 'retention.export' and data->>'exportOf' = $1)`,
    [ws],
  );
  return Number(rows[0]!.n);
}

/** The storage keys of the Workspace's media files and of its export ZIPs not yet removed. */
export async function storageKeys(db: OwnerDb, ws: string): Promise<string[]> {
  const { rows } = await db.query(
    `select storage_key from public.media where workspace_id = $1
     union select storage_key from public.workspace_exports where workspace_id = $1 and removed_at is null`,
    [ws],
  );
  return rows.map((r) => r.storage_key as string);
}

export async function suppressedAddresses(db: OwnerDb, ws: string): Promise<string[]> {
  return (await db.query("select email from public.suppressions where workspace_id = $1", [ws])).rows.map((r) => r.email as string);
}

export type OpenReceipt = { id: number; filesRemoved: number | null; hashesWritten: number | null };

export async function openReceipt(db: OwnerDb, ws: string): Promise<OpenReceipt | null> {
  const { rows } = await db.query("select id, files_removed, hashes_written from system.purge_receipts where workspace = $1 and finished_at is null", [ws]);
  const r = rows[0];
  return r ? { id: Number(r.id), filesRemoved: r.files_removed as number | null, hashesWritten: r.hashes_written as number | null } : null;
}

export const startPurge = async (db: OwnerDb, ws: string, actor: string, replay: boolean) =>
  Number((await call(db, "select system.purge_start($1, $2, $3) as id", [ws, actor, replay])).id);

export const purgeBatch = async (db: OwnerDb, ws: string, table: string, limit: number) =>
  Number((await call(db, "select system.purge_workspace_batch($1, $2, $3) as n", [ws, table, limit])).n);

export const markFilesRemoved = (db: OwnerDb, ws: string, count: number) => call(db, "select system.purge_files_removed($1, $2)", [ws, count]);

export const writeHashes = (db: OwnerDb, ws: string, hashes: string[]) => call(db, "select system.purge_write_hashes($1, $2::text[])", [ws, hashes]);

export const finishPurge = async (db: OwnerDb, ws: string) => (await call(db, "select system.purge_finish($1) as receipt", [ws])).receipt as Receipt;

/**
 * A closed purge receipt, as system.purge_finish returns it: counts only, no content. `kept` is empty for
 * a normal purge. It names rows left only when something outside the Workspace still references them
 * (table to rows, the workspaces row then kept too), or the Organization row with what references it.
 */
export type Receipt = {
  id: number;
  workspace: string;
  actor: string;
  replay: boolean;
  started_at: string;
  finished_at: string;
  outcome: "purged";
  files_removed: number;
  hashes_written: number;
  rows: Record<string, number>;
  kept: Record<string, number | string>;
};
