// SPDX-License-Identifier: AGPL-3.0-only
// Where a page of the Item list ends: the order it was read in, that order's sort key on the last
// row, and the row's id. Times keep Postgres's microseconds, so rows in one millisecond still page
// apart. Opaque to callers, and a cursor from one order never pages another.

/** Needs you (by deadline), time (by when it goes, for a date range), or newest made first. */
export type ListOrder = "needs_you" | "time" | "newest";

/** needs_you keys on [deadline or null, made at]; time on [goes at]; newest on [made at]. */
export type ListPoint = { order: ListOrder; key: (string | null)[]; id: string };

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEYS: Record<ListOrder, number> = { needs_you: 2, time: 1, newest: 1 };

/** The order a list read uses, from its filter. */
export const orderOf = (f: { needsYou?: boolean; from?: unknown; to?: unknown }): ListOrder => (f.needsYou ? "needs_you" : f.from || f.to ? "time" : "newest");

export const encodeListCursor = (p: ListPoint) => Buffer.from(JSON.stringify([p.order, ...p.key, p.id])).toString("base64url");

/** The point a cursor names, or null when it isn't one this list made for `order`. */
export function parseListCursor(cursor: string, order: ListOrder): ListPoint | null {
  let parts: unknown;
  try {
    parts = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parts) || parts[0] !== order || parts.length !== KEYS[order] + 2) return null;
  const key = parts.slice(1, -1) as unknown[];
  const id = parts.at(-1);
  // Only a needs-you deadline may be missing.
  const keyOk = key.every((k, n) => (typeof k === "string" && TIME.test(k)) || (k === null && order === "needs_you" && n === 0));
  if (!keyOk || typeof id !== "string" || !UUID.test(id)) return null;
  const point = { order, key: key as (string | null)[], id };
  return encodeListCursor(point) === cursor ? point : null;
}
