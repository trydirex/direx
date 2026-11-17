// SPDX-License-Identifier: AGPL-3.0-only
// Export rows and the reads an export makes. Every read runs inside the Workspace, so RLS scopes it to
// that Workspace's rows; only the sweep's list of expired ZIPs crosses Workspaces, through its system
// function.
import { withSystem, withWorkspace } from "@direx/db";
import { RETENTION, TENANT_CLASSES } from "@direx/db/retention";
import { workspaceExports } from "@direx/db/schema-retention";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";

export type ExportRow = typeof workspaceExports.$inferSelect;

/** Every table that holds a Workspace's rows, from the retention list, schema-qualified. */
export const TENANT_TABLES: readonly string[] = Object.entries(RETENTION)
  .filter(([, r]) => TENANT_CLASSES.includes(r.class))
  .map(([name]) => name);

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** A new export, unless one asked for since `busySince` is still being built. */
export function insertExport(workspaceId: string, requestedBy: string, at: Date, busySince: Date): Promise<ExportRow | null> {
  return withWorkspace(workspaceId, async (tx) => {
    // One request at a time per Workspace; the lock makes two clicks at once start one build.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`export:${workspaceId}`}, 0))`);
    const [busy] = await tx
      .select({ id: workspaceExports.id })
      .from(workspaceExports)
      .where(and(isNull(workspaceExports.readyAt), isNull(workspaceExports.failedAt), gt(workspaceExports.requestedAt, busySince)));
    if (busy) return null;
    const id = crypto.randomUUID();
    const [row] = await tx.insert(workspaceExports).values({ id, workspaceId, requestedBy, requestedAt: at, storageKey: `${workspaceId}/${id}` }).returning();
    return row!;
  });
}

export function recentExports(workspaceId: string, limit: number): Promise<ExportRow[]> {
  return withWorkspace(workspaceId, (tx) => tx.select().from(workspaceExports).orderBy(desc(workspaceExports.requestedAt)).limit(limit));
}

export function findExport(workspaceId: string, id: string): Promise<ExportRow | undefined> {
  return withWorkspace(workspaceId, async (tx) => (await tx.select().from(workspaceExports).where(eq(workspaceExports.id, id)))[0]);
}

export function markReady(workspaceId: string, id: string, bytes: number, at: Date, expiresAt: Date): Promise<void> {
  return withWorkspace(workspaceId, async (tx) => {
    await tx.update(workspaceExports).set({ readyAt: at, bytes, expiresAt }).where(and(eq(workspaceExports.id, id), isNull(workspaceExports.failedAt)));
  });
}

export function markFailed(workspaceId: string, id: string, at: Date): Promise<void> {
  return withWorkspace(workspaceId, async (tx) => {
    await tx.update(workspaceExports).set({ failedAt: at }).where(and(eq(workspaceExports.id, id), isNull(workspaceExports.readyAt)));
  });
}

export function markRemoved(workspaceId: string, id: string, at: Date): Promise<void> {
  return withWorkspace(workspaceId, async (tx) => {
    await tx.update(workspaceExports).set({ removedAt: at }).where(and(eq(workspaceExports.id, id), isNull(workspaceExports.removedAt)));
  });
}

export type DueExport = { workspaceId: string; id: string; storageKey: string };

/** Exports past their 24 hours, or failed, whose ZIP is still stored, across Workspaces. */
export async function exportSweepDue(): Promise<DueExport[]> {
  const { rows } = await withSystem((tx) => tx.execute(sql`select workspace_id, id, storage_key from system.export_sweep_due()`));
  return rows.map((r) => ({ workspaceId: r.workspace_id as string, id: r.id as string, storageKey: r.storage_key as string }));
}

/** Rows a table read fetches at a time [DEFAULT]. */
const BATCH = 1000;

/**
 * Hands each batch of a table's rows to `onBatch` as JSON text, one line per row, without `omit`'s
 * columns. One transaction and cursor per table, so a large table never sits in memory whole.
 */
export function readTable(workspaceId: string, table: string, omit: readonly string[], onBatch: (lines: string[]) => Promise<void>): Promise<number> {
  const [schema, name] = table.split(".");
  if (!schema || !name || !IDENT.test(schema) || !IDENT.test(name) || !omit.every((c) => IDENT.test(c))) throw new Error(`export: not a table name: ${table}`);
  const dropped = omit.length ? ` - array[${omit.map((c) => `'${c}'`).join(", ")}]::text[]` : "";
  return withWorkspace(workspaceId, async (tx) => {
    // RLS already scopes the read; the explicit filter says so twice.
    await tx.execute(
      sql`${sql.raw(`declare export_rows no scroll cursor for select (to_jsonb(t)${dropped})::text as line from ${schema}.${name} t where t.workspace_id = `)}${workspaceId}::uuid`,
    );
    let rows = 0;
    for (;;) {
      const { rows: got } = await tx.execute(sql.raw(`fetch ${BATCH} from export_rows`));
      if (!got.length) return rows;
      rows += got.length;
      await onBatch(got.map((r) => r.line as string));
    }
  });
}

export type StoredFile = { id: string; storageKey: string; contentType: string };

/** The Workspace's files whose bytes are still stored: not deleted, not swept. */
export async function liveFiles(workspaceId: string): Promise<StoredFile[]> {
  const { rows } = await withWorkspace(workspaceId, (tx) =>
    tx.execute(sql`select id, storage_key, content_type from public.media where deleted_at is null and bytes_removed_at is null order by created_at`),
  );
  return rows.map((r) => ({ id: r.id as string, storageKey: r.storage_key as string, contentType: r.content_type as string }));
}
