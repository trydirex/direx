// SPDX-License-Identifier: AGPL-3.0-only
// When a person's review blocks fall: their weekdays over the next 14 days, at their local
// time. The clock comes in as an argument; time zone sums are the schedule module's.
import { localTime, mailboxDay, nextDay } from "../../schedule/index";
import type { Block, FeedSettings } from "../domain/ics";

export const WINDOW_DAYS = 14;

const isoWeekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay() || 7;

export function reviewBlocks(s: FeedSettings, now: Date): Block[] {
  const blocks: Block[] = [];
  let day = mailboxDay(now, s.timeZone);
  for (let i = 0; i < WINDOW_DAYS; i++, day = nextDay(day)) {
    if (!s.weekdays.includes(isoWeekday(day))) continue;
    blocks.push({ day, start: localTime(day, s.startMinute, s.timeZone), end: localTime(day, s.startMinute + s.lengthMinutes, s.timeZone) });
  }
  return blocks;
}
