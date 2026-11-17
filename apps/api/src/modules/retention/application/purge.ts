// SPDX-License-Identifier: AGPL-3.0-only
// The Workspace purge (ADR 0030 rules 003, 004 and 007), run by a Server admin's command as the owner. A
// resumable sequence: mark the Workspace purging, delete its jobs, remove its media files and export
// ZIPs from storage, write its opt-outs as keyed hashes, delete its rows table by table, children first,
// in batches, ledger and consent records included (ADR 0030 Q3), and close the receipt, which deletes the
// Workspace's row and, after its last Workspace, the Organization's. Each step is recorded on the open receipt, so running the command
// again after a stop carries on from there. The definers refuse anything out of order.
import type { SuppressionHasher } from "../../credentials/index";
import type { Store } from "../../media/index";
import {
  finishPurge,
  foreignKeys,
  jobCount,
  lastOfOrganization,
  markFilesRemoved,
  openReceipt,
  purgeBatch,
  refusal,
  rowCounts,
  startPurge,
  storageKeys,
  suppressedAddresses,
  tenantTables,
  writeHashes,
  type OwnerDb,
  type Receipt,
} from "../adapters/purge-repo";
import { deletionOrder, LAST } from "../domain/purge";

/** Rows the purge deletes per call, so no one transaction holds a large Workspace's locks [DEFAULT]. */
export const PURGE_BATCH = 1000;

export type PurgeDeps = { db: OwnerDb; store: Pick<Store, "remove">; hasher: SuppressionHasher; batch?: number };

export type PurgePreview = {
  /** Why the purge would refuse, or null. */
  refusal: string | null;
  /** Rows per table the purge would delete, empty tables left out; the Organization's row when this is its last Workspace. */
  remove: Record<string, number>;
  jobs: number;
  files: number;
};

export const purgeRefusal = refusal;

/** What a purge of this Workspace would remove now, changing nothing. */
export async function previewPurge(db: OwnerDb, ws: string): Promise<PurgePreview> {
  const remove = await rowCounts(db, ws, await tenantTables(db));
  if (await lastOfOrganization(db, ws)) remove["public.organizations"] = 1;
  return { refusal: await refusal(db, ws), remove, jobs: await jobCount(db, ws), files: (await storageKeys(db, ws)).length };
}

async function drain(db: OwnerDb, ws: string, table: string, batch: number): Promise<void> {
  for (;;) if ((await purgeBatch(db, ws, table, batch)) < batch) return;
}

/**
 * Purges a Workspace, or resumes the purge already open on it. `replay` re-runs a purge recorded by a
 * receipt newer than a restored backup, where the Workspace may still look live or recent; the system
 * Workspace is refused all the same. Throws PurgeRefused with the reason.
 */
export async function purgeWorkspace(ws: string, actor: string, deps: PurgeDeps, opts: { replay?: boolean } = {}): Promise<Receipt> {
  const { db, store, batch = PURGE_BATCH } = deps;
  await startPurge(db, ws, actor, opts.replay ?? false);
  // No job may start for it again, an export build included.
  await drain(db, ws, "pgboss.job", batch);
  const open = (await openReceipt(db, ws))!;
  if (open.filesRemoved === null) {
    // The rows keep their keys until the bytes are gone; removing a missing key is not an error.
    const keys = await storageKeys(db, ws);
    for (const key of keys) await store.remove(key);
    await markFilesRemoved(db, ws, keys.length);
  }
  if (open.hashesWritten === null) {
    const addresses = await suppressedAddresses(db, ws);
    // The key is made by the first purge that has an opt-out to keep.
    const hash = addresses.length ? await deps.hasher(true) : null;
    await writeHashes(db, ws, hash ? [...new Set(addresses.map(hash))] : []);
  }
  const order = deletionOrder((await tenantTables(db)).filter((t) => !LAST.includes(t)), await foreignKeys(db));
  for (const table of order) await drain(db, ws, table, batch);
  return finishPurge(db, ws);
}
