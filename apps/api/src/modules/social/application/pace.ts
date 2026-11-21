// SPDX-License-Identifier: AGPL-3.0-only
// A Social account's pace (ADR 0038): when it posts and how far apart. Pure, with the clock passed
// in. It lives here, not in domain/, because the day and wall-clock helpers are schedule's.
import { localTime, mailboxDay } from "../../schedule";

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

export type OffPace = "outside_hours" | "inside_gap";

/** Why a time breaks the pace, or null when it keeps it. `taken` is the account's other planned posts. */
export function offPace(at: Date, pace: SocialPace, timeZone: string, taken: readonly Date[]): OffPace | null {
  const on = mailboxDay(at, timeZone);
  if ((!pace.weekends && isWeekend(on)) || at < localTime(on, pace.from, timeZone) || at >= localTime(on, pace.until, timeZone)) return "outside_hours";
  const gap = pace.gapMinutes * 60_000;
  return taken.some((t) => Math.abs(t.getTime() - at.getTime()) < gap) ? "inside_gap" : null;
}

// Every 15 minutes from an opening on the quarter hour, plus an offset of 1 to 12, never lands on a quarter hour.
const STEP = 15 * 60_000;

/**
 * The first time on `wanted`'s day, at or after it, that keeps the pace. Candidates sit on one grid
 * per day and seed (opening, plus the offset, then every 15 minutes), so placing a time this returned
 * gives it back unchanged. Null when nothing on that day fits; a post never moves to another day.
 */
export function place(a: { wanted: Date; pace: SocialPace; timeZone: string; taken: readonly Date[]; seed: string }): Date | null {
  const on = mailboxDay(a.wanted, a.timeZone);
  if (!a.pace.weekends && isWeekend(on)) return null;
  const first = localTime(on, a.pace.from, a.timeZone).getTime() + offsetMinutes(a.seed) * 60_000;
  const closes = localTime(on, a.pace.until, a.timeZone).getTime();
  // ponytail: a linear scan over one day, at most 96 candidates.
  for (let at = first + Math.max(0, Math.ceil((a.wanted.getTime() - first) / STEP)) * STEP; at < closes; at += STEP) {
    if (!offPace(new Date(at), a.pace, a.timeZone, a.taken)) return new Date(at);
  }
  return null;
}
