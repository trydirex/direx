// SPDX-License-Identifier: AGPL-3.0-only
// A wall-clock time on a day in a time zone. When a step's emails go out is the Mailbox's pace, in the
// schedule module.

function offsetMs(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second")) - Math.floor(at / 1000) * 1000;
}

export function localTime(day: string, minutes: number, timeZone: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  // Minutes may carry seconds, as an evenly spaced send time does.
  const wall = Date.UTC(y, m - 1, d) + Math.round(minutes * 60_000);
  // A second pass settles a time near a clock change.
  const first = wall - offsetMs(wall, timeZone);
  return new Date(wall - offsetMs(first, timeZone));
}
