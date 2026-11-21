// SPDX-License-Identifier: AGPL-3.0-only
// A Social account's pace (ADR 0038): when it posts and how far apart. Pure, with the clock passed
// in.

/** Minutes from midnight in the Workspace's time zone. */
export type SocialPace = { from: number; until: number; weekends: boolean; gapMinutes: number };

/** [DEFAULT] For a Network that names no pace of its own: every day, 08:00 to 20:00, an hour apart. */
export const DEFAULT_SOCIAL_PACE: SocialPace = { from: 8 * 60, until: 20 * 60, weekends: true, gapMinutes: 60 };

/** The account's own columns; null means its Network's default. `postingFrom` and `postingUntil` are set together. */
export type PaceColumns = { postingFrom: number | null; postingUntil: number | null; postingWeekends: boolean | null; gapMinutes: number | null };

export function paceOf(account: PaceColumns, network: SocialPace | undefined): SocialPace {
  const base = network ?? DEFAULT_SOCIAL_PACE;
  return {
    from: account.postingFrom ?? base.from,
    until: account.postingUntil ?? base.until,
    weekends: account.postingWeekends ?? base.weekends,
    gapMinutes: account.gapMinutes ?? base.gapMinutes,
  };
}

/** FNV-1a, 32 bits: a stable number from a string, not a secret. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** [DEFAULT] 1 to 12 minutes, the same for one seed every time, so a post never lands on the hour. */
export const offsetMinutes = (seed: string) => 1 + (fnv1a(seed) % 12);

const isWeekend = (on: string) => [0, 6].includes(new Date(`${on}T00:00:00Z`).getUTCDay());

const wallClock = (timeZone: string) => new Intl.DateTimeFormat("en-CA", {
  timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function localReading(at: Date, clock: Intl.DateTimeFormat) {
  const parts = clock.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return { on: `${part("year")}-${part("month")}-${part("day")}`, minutes: Number(part("hour")) * 60 + Number(part("minute")) };
}

const withinHours = (minutes: number, pace: SocialPace) => minutes >= pace.from && minutes < pace.until;
const MINUTE_MS = 60_000;
const insideGap = (at: Date, pace: SocialPace, taken: readonly Date[]) =>
  taken.some((t) => Math.abs(t.getTime() - at.getTime()) < pace.gapMinutes * MINUTE_MS);

export type OffPace = "outside_hours" | "inside_gap";

/** Why a time breaks the pace, or null when it keeps it. `taken` is the account's other planned posts. */
export function offPace(at: Date, pace: SocialPace, timeZone: string, taken: readonly Date[]): OffPace | null {
  const { on, minutes } = localReading(at, wallClock(timeZone));
  if ((!pace.weekends && isWeekend(on)) || !withinHours(minutes, pace)) return "outside_hours";
  return insideGap(at, pace, taken) ? "inside_gap" : null;
}

/**
 * The first time on `wanted`'s day, at or after it, that keeps the pace. Candidates sit on one grid
 * per day and seed (each local quarter hour plus the offset), so placing a time this returned gives
 * it back unchanged. Null when nothing on that day fits; a post never moves to another day.
 */
export function place(a: { wanted: Date; pace: SocialPace; timeZone: string; taken: readonly Date[]; seed: string }): Date | null {
  const clock = wallClock(a.timeZone);
  const { on } = localReading(a.wanted, clock);
  if (!a.pace.weekends && isWeekend(on)) return null;
  const offset = offsetMinutes(a.seed);
  // Scan real minutes in order so gaps are skipped and both occurrences of a repeated slot can fit.
  for (let ms = Math.ceil(a.wanted.getTime() / MINUTE_MS) * MINUTE_MS; ; ms += MINUTE_MS) {
    const at = new Date(ms);
    const reading = localReading(at, clock);
    if (reading.on !== on) return null;
    if (reading.minutes % 15 === offset && withinHours(reading.minutes, a.pace) && !insideGap(at, a.pace, a.taken)) return at;
  }
}
