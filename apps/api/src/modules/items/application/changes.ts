// SPDX-License-Identifier: AGPL-3.0-only
// What changed state since a cursor, for the door's read_changes (door-reads spec). An event is
// handed out only once every older transaction has finished, so a change can arrive late but is
// never skipped or repeated. With no cursor, nothing comes back but a cursor for now, so a new
// reader starts from the present. Items are never deleted outside a Workspace purge.
import { changesAfter, inWorkspace, snapshotBounds } from "../adapters/repo";
import { encodeCursor, parseCursor } from "../domain/cursor";

export type Change = { itemId: string; kind: string; from: string | null; to: string; at: Date };
export type Changes = { ok: true; events: Change[]; cursor: string; more: boolean } | { ok: false; reason: "bad_cursor" };

const BAD = { ok: false, reason: "bad_cursor" } as const;

export async function changes(workspaceId: string, cursor: string | null, limit: number): Promise<Changes> {
  const after = cursor === null ? null : parseCursor(cursor);
  if (cursor !== null && !after) return BAD;
  return inWorkspace(workspaceId, async (tx) => {
    const { xmin, xmax } = await snapshotBounds(tx);
    if (!after) return { ok: true, events: [], cursor: encodeCursor({ tx: xmin, id: 0 }), more: false };
    if (after.tx > xmax) return BAD;
    const rows = await changesAfter(tx, after, xmin, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      ok: true,
      events: page.map(({ itemId, kind, from, to, at }) => ({ itemId, kind, from, to, at })),
      cursor: last ? encodeCursor({ tx: BigInt(last.tx), id: last.id }) : cursor!,
      more: rows.length > limit,
    };
  });
}
