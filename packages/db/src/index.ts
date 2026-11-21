// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { closeDb, getDb, UUID, type Db } from "./client";
import { migrationState, type MigrationState } from "./migrate";
import { RETENTION } from "./retention";

// No client or pool leaves packages/db. withWorkspace is how application code and job
// workers get a query handle; withUser (./user) and authDb (./auth) are the two narrow
// exceptions.

export type WorkspaceTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A Workspace the purge has started on: no request or job may touch it again (ADR 0030 rule 007). */
export class WorkspacePurging extends Error {
  constructor(readonly workspaceId: string) {
    super(`withWorkspace: Workspace ${workspaceId} is being purged`);
  }
}

export function withWorkspace<T>(workspaceId: string, fn: (tx: WorkspaceTx) => Promise<T>): Promise<T> {
  if (!UUID.test(workspaceId)) throw new Error("withWorkspace: workspaceId must be a uuid");
  return getDb().transaction(async (tx) => {
    // is_local = true is SET LOCAL: the setting ends with the transaction. The purge's mark is read in the
    // same statement, through a definer, so the check costs no extra round trip.
    const { rows } = await tx.execute<{ purging: boolean }>(
      sql`select set_config('app.workspace_id', ${workspaceId}, true), system.workspace_purging(${workspaceId}::uuid) as purging`,
    );
    if (rows[0]?.purging) throw new WorkspacePurging(workspaceId);
    return fn(tx);
  });
}

// The single cross-workspace path. Built with the All clients view.
export function withCrossWorkspace(): never {
  throw new Error("withCrossWorkspace: not implemented");
}

// The system path for sweeps and webhooks. It sets no workspace, so RLS hides every tenant row
// and only the functions in the system schema can see across Workspaces.
export function withSystem<T>(fn: (tx: WorkspaceTx) => Promise<T>): Promise<T> {
  return getDb().transaction(fn);
}

export { closeDb };

/** Rows a sweep deletes in one transaction [DEFAULT]. */
export const SWEEP_BATCH = 1000;

/**
 * The daily retention sweep (ADR 0030 rule 002): each registered database sweep, in list
 * order, one batch per transaction until a batch comes back short. Returns the rows removed per table.
 */
export async function sweepRetention(batch = SWEEP_BATCH): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  for (const [table, r] of Object.entries(RETENTION)) {
    const sweep = "sweep" in r ? r.sweep : undefined;
    if (!sweep || !/^(system|auth)\.sweep_\w+$/.test(sweep)) continue;
    let total = 0;
    for (;;) {
      const { rows } = await withSystem((tx) => tx.execute(sql`select ${sql.raw(sweep)}(${batch}::integer) as n`));
      const n = Number(rows[0]?.n ?? 0);
      total += n;
      if (n < batch) break;
    }
    removed[table] = total;
  }
  return removed;
}

/** What the app's own database has not applied yet, read as the app role (ADR 0029 rule 008). */
export function migrationsPending(): Promise<MigrationState> {
  return migrationState(getDb().$client, fileURLToPath(new URL("../migrations", import.meta.url)));
}
export type { MigrationState };
export { listen } from "./listen";
