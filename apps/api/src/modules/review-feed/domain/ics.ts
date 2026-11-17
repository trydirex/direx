// SPDX-License-Identifier: AGPL-3.0-only
// Pure: a review feed as iCalendar text (RFC 5545). It carries counts, a date and one link,
// never anything from a draft, because the feed URL can be forwarded.

/** A member's review time. Weekdays are ISO: 1 is Monday, 7 is Sunday. The start is minutes from local midnight. */
export type FeedSettings = { weekdays: number[]; startMinute: number; lengthMinutes: number; timeZone: string };

/** One review block: its local day ("2026-11-17") and its start and end instants. */
export type Block = { day: string; start: Date; end: Date };

export type FeedInput = {
  /** Unique per feed owner, such as "<workspaceId>-<userId>"; each block adds its day. */
  uidBase: string;
  blocks: Block[];
  count: number;
  nextDeadline: Date | null;
  timeZone: string;
  homeUrl: string;
  now: Date;
};

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** RFC 5545 text: backslash, semicolon, comma and line breaks are escaped. */
export const escapeText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Lines longer than 75 octets go on continuation lines that start with a space, never inside a character. */
export function fold(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = "";
  let size = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74;
    if (size + n > limit) {
      out.push(cur);
      cur = "";
      size = 0;
    }
    cur += ch;
    size += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const dayWords = (at: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(at);
const clock = (at: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);

export function summary(count: number, nextDeadline: Date | null, timeZone: string): string {
  if (count === 0) return "Direx review: nothing waiting";
  return `Direx review: ${count} waiting${nextDeadline ? `, next due ${dayWords(nextDeadline, timeZone)}` : ""}`;
}

export function reviewIcs(f: FeedInput): string {
  const title = summary(f.count, f.nextDeadline, f.timeZone);
  const note = `Counted at ${dayWords(f.now, f.timeZone)} ${clock(f.now, f.timeZone)}. Open Needs you: ${f.homeUrl}`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Direx//Review feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Direx review",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ...f.blocks.flatMap((b) => [
      "BEGIN:VEVENT",
      `UID:review-${f.uidBase}-${b.day}@direx`,
      `DTSTAMP:${stamp(f.now)}`,
      `DTSTART:${stamp(b.start)}`,
      `DTEND:${stamp(b.end)}`,
      `SUMMARY:${escapeText(title)}`,
      `DESCRIPTION:${escapeText(note)}`,
      `URL:${f.homeUrl}`,
      "TRANSP:OPAQUE",
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
