// SPDX-License-Identifier: AGPL-3.0-only
// Pure: a Mailbox's daily limit and sending hours. No I/O; the clock comes in as an argument.
import { counts, type ActionState } from "./caps";

/** A Mailbox's pace, as stored on its credential. Hours are minutes from midnight in the Workspace's time zone. */
export type MailboxPace = { dailyLimit: number; sendFrom: number; sendUntil: number; sendWeekends: boolean };

export const DEFAULT_PACE: MailboxPace = { dailyLimit: 50, sendFrom: 9 * 60, sendUntil: 17 * 60, sendWeekends: false };

const day = (timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });

/** The Workspace day a time falls on, as "2026-11-09". */
export const mailboxDay = (at: Date, timeZone: string): string => day(timeZone).format(at);

function offsetMs(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second")) - Math.floor(at / 1000) * 1000;
}

/** The instant of a wall-clock time on a day in a time zone. Minutes may be fractional. */
export function localTime(on: string, minutes: number, timeZone: string): Date {
  const [y, m, d] = on.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d) + Math.round(minutes * 60_000);
  // A second pass settles a time near a clock change.
  const first = wall - offsetMs(wall, timeZone);
  return new Date(wall - offsetMs(first, timeZone));
}

export const nextDay = (on: string) => new Date(Date.parse(`${on}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const isWeekend = (on: string) => [0, 6].includes(new Date(`${on}T00:00:00Z`).getUTCDay());

/** Whether a Mailbox sends at all on this day. */
export const sendsOn = (on: string, pace: MailboxPace) => pace.sendWeekends || !isWeekend(on);

/** The minutes between two sends, so a full day's limit fits inside the hours. */
export const spacing = (pace: MailboxPace) => (pace.sendUntil - pace.sendFrom) / pace.dailyLimit;

/** The time of a day's `n`th send (from 0), evenly spaced inside the hours. */
export const nthSlot = (on: string, n: number, pace: MailboxPace, timeZone: string) => localTime(on, pace.sendFrom + n * spacing(pace), timeZone);

/** Whether a time falls inside the Mailbox's hours on a day it sends. */
export function insideHours(at: Date, pace: MailboxPace, timeZone: string): boolean {
  const on = mailboxDay(at, timeZone);
  return sendsOn(on, pace) && at >= localTime(on, pace.sendFrom, timeZone) && at < localTime(on, pace.sendUntil, timeZone);
}

/**
 * Send times for `count` emails from day `on`: evenly spaced inside the hours, at most the limit a
 * day after what each day already has, skipping days the Mailbox doesn't send and times before
 * `notBefore`.
 */
export function plan(a: { on: string; count: number; pace: MailboxPace; timeZone: string; taken?: Record<string, number>; notBefore?: Date }): Date[] {
  const out: Date[] = [];
  // ponytail: a year of days is the search horizon; a step that can't fit in it plans what fits.
  for (let on = a.on, days = 0; out.length < a.count && days < 366; on = nextDay(on), days++) {
    if (!sendsOn(on, a.pace)) continue;
    for (let n = a.taken?.[on] ?? 0; n < a.pace.dailyLimit && out.length < a.count; n++) {
      const at = nthSlot(on, n, a.pace, a.timeZone);
      if (!a.notBefore || at >= a.notBefore) out.push(at);
    }
  }
  return out;
}

export type MailboxReservationRow = { actionId: string; day: string; slot: Date; createdAt: Date };

/**
 * How many emails count on a Mailbox's day: per Action only its newest reservation, only when that
 * is on this day, and only while its Action's state counts.
 */
export function countedOn(on: string, newest: readonly MailboxReservationRow[], states: ReadonlyMap<string, ActionState>, now: Date, exceptActionId?: string): number {
  return newest.filter((r) => r.day === on && r.actionId !== exceptActionId && counts(r.slot, states.get(r.actionId), now)).length;
}
