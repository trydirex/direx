// SPDX-License-Identifier: AGPL-3.0-only
// A point in the changes feed: the writing transaction and the event id, in that order, so an event
// that commits late still sorts after every point handed out before it. Opaque to callers.
export type ChangePoint = { tx: bigint; id: number };

export const encodeCursor = (p: ChangePoint) => Buffer.from(`${p.tx}.${p.id}`).toString("base64url");

/** The point a cursor names, or null when it isn't one this feed made. */
export function parseCursor(cursor: string): ChangePoint | null {
  const m = /^(\d{1,20})\.(\d{1,15})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!m || encodeCursor({ tx: BigInt(m[1]!), id: Number(m[2]) }) !== cursor) return null;
  return { tx: BigInt(m[1]!), id: Number(m[2]) };
}
