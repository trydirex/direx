// SPDX-License-Identifier: AGPL-3.0-only
// Pure: the order the Workspace purge empties tables in (ADR 0030 rules 004 and 007).

/** Not emptied in batches: system.purge_finish deletes the Workspace's own row once every other table is empty. */
export const LAST: readonly string[] = ["public.workspaces"];

export type Edge = { child: string; parent: string };

/**
 * Children before parents: a table goes once every table that references it has gone. A table's
 * reference to itself holds nothing up (its definer takes it whole), and a table left out of `tables`
 * holds nothing up. A cycle between tables throws.
 */
export function deletionOrder(tables: readonly string[], edges: readonly Edge[]): string[] {
  const waiting = new Map(tables.map((t) => [t, new Set<string>()]));
  for (const { child, parent } of edges) if (child !== parent && waiting.has(child)) waiting.get(parent)?.add(child);
  const out: string[] = [];
  while (waiting.size) {
    const ready = [...waiting].filter(([, children]) => children.size === 0).map(([t]) => t).sort();
    if (!ready.length) throw new Error(`purge: the foreign keys between ${[...waiting.keys()].sort().join(", ")} form a cycle`);
    for (const t of ready) {
      out.push(t);
      waiting.delete(t);
      for (const children of waiting.values()) children.delete(t);
    }
  }
  return out;
}
