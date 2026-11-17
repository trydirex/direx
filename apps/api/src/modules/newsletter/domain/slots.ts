// SPDX-License-Identifier: AGPL-3.0-only
// Pure: when the weekly issue goes out and when its draft is due, in the Workspace's own time zone,
// so "Tuesday 09:00" stays 09:00 across a clock change. The wall-clock-to-instant step is the same
// two-pass method the campaign slots use, kept here so this module needs nothing from campaigns.
export type Slot = { weekday: number; sendTime: string; timeZone: string };

const DAY = 24 * 60 * 60 * 1000;
/** More than this without an issue, and the next one warns: readers forget a list that goes quiet. */
export const GAP_DAYS = 31;
/** The draft is due this many days before its slot, at DRAFT_HOUR local time. */
export const DRAFT_DAYS_BEFORE = 2;
export const DRAFT_HOUR = 6;

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** The local calendar day and ISO weekday of an instant in a time zone. */
export function localDay(at: Date, timeZone: string): { y: number; m: number; d: number; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", weekday: "short" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), weekday: WEEKDAYS[parts.weekday!]! };
}

/** How far the zone's wall clock is ahead of UTC at this instant, in ms. */
function offsetAt(at: number, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(new Date(at))
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(at / 1000) * 1000;
}

/** The instant a wall-clock time on a local day happens in a time zone. A second pass settles a time near a clock change. */
export function atLocal(y: number, m: number, d: number, hour: number, minute: number, timeZone: string): Date {
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  const first = wall - offsetAt(wall, timeZone);
  return new Date(wall - offsetAt(first, timeZone));
}

/** The local day `days` after the given one. */
const plusDays = (day: { y: number; m: number; d: number }, days: number) => localDay(new Date(Date.UTC(day.y, day.m - 1, day.d + days, 12)), "UTC");

/** The next slot strictly after `now`. */
export function nextSlot(s: Slot, now: Date): Date {
  const [hour, minute] = s.sendTime.split(":").map(Number) as [number, number];
  const today = localDay(now, s.timeZone);
  for (let i = 0; i <= 7; i++) {
    const day = plusDays(today, i);
    if (day.weekday !== s.weekday) continue;
    const at = atLocal(day.y, day.m, day.d, hour, minute, s.timeZone);
    if (at.getTime() > now.getTime()) return at;
  }
  // Unreachable: within eight days the weekday comes round with its time still ahead.
  throw new Error("no slot in the next eight days");
}

/** When the draft for this slot is due: DRAFT_DAYS_BEFORE local days earlier, at DRAFT_HOUR local time. */
export function draftDue(slot: Date, timeZone: string): Date {
  const before = plusDays(localDay(slot, timeZone), -DRAFT_DAYS_BEFORE);
  return atLocal(before.y, before.m, before.d, DRAFT_HOUR, 0, timeZone);
}

/** Whether it has been more than GAP_DAYS since the last issue went out. Never warns before the first. */
export const gapWarning = (lastSentAt: Date | null, now: Date): boolean => lastSentAt !== null && now.getTime() - lastSentAt.getTime() > GAP_DAYS * DAY;
