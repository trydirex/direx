// SPDX-License-Identifier: AGPL-3.0-only
// The review feed's text and its block times: escaping, folding, stable UIDs, local times
// across a clock change, and nothing in the feed but counts, times and one link.
import { expect, test } from "vitest";
import { reviewBlocks } from "./application/blocks";
import { escapeText, fold, reviewIcs, summary, type FeedSettings } from "./domain/ics";

const NOW = new Date("2026-11-13T12:00:00Z"); // a Friday
const TUE_THU: FeedSettings = { weekdays: [2, 4], startMinute: 10 * 60, lengthMinutes: 30, timeZone: "Europe/London" };
const feed = (count: number, nextDeadline: Date | null, s = TUE_THU) =>
  reviewIcs({ uidBase: "w1-u1", blocks: reviewBlocks(s, NOW), count, nextDeadline, timeZone: s.timeZone, homeUrl: "https://app.example/w/w1", now: NOW });
const unfold = (ics: string) => ics.replace(/\r\n /g, "");

test("text escapes backslash, semicolon, comma and line breaks", () => {
  expect(escapeText("a\\b;c,d\ne")).toBe("a\\\\b\\;c\\,d\\ne");
});

test("long lines fold at 75 octets without splitting a character, and unfold to the same text", () => {
  const line = `SUMMARY:${"é".repeat(60)}`;
  const folded = fold(line);
  for (const part of folded.split("\r\n")) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
  expect(folded.replace(/\r\n /g, "")).toBe(line);
  expect(fold("short")).toBe("short");
});

test("blocks fall only on the chosen weekdays inside 14 days, at the local time", () => {
  const blocks = reviewBlocks(TUE_THU, NOW);
  expect(blocks.map((b) => b.day)).toEqual(["2026-11-17", "2026-11-19", "2026-11-24", "2026-11-26"]);
  expect(blocks[0]).toEqual({ day: "2026-11-17", start: new Date("2026-11-17T10:00:00Z"), end: new Date("2026-11-17T10:30:00Z") });
});

test("a block on the day the clocks go forward still starts at the chosen local time", () => {
  const s: FeedSettings = { weekdays: [6, 7], startMinute: 10 * 60, lengthMinutes: 60, timeZone: "Europe/Warsaw" };
  const blocks = reviewBlocks(s, new Date("2027-03-22T12:00:00Z"));
  // Saturday is still on winter time (UTC+1); Sunday 28 March is on summer time (UTC+2).
  expect(blocks.slice(0, 2).map((b) => b.start.toISOString())).toEqual(["2027-03-27T09:00:00.000Z", "2027-03-28T08:00:00.000Z"]);
});

test("the title says how much is waiting and when the next one is due, or that nothing is", () => {
  expect(summary(0, null, "Europe/London")).toBe("Direx review: nothing waiting");
  expect(summary(7, new Date("2026-11-21T09:00:00Z"), "Europe/London")).toBe("Direx review: 7 waiting, next due Sat 21 Nov");
  expect(summary(2, null, "Europe/London")).toBe("Direx review: 2 waiting");
});

test("each block has a UID from its day that stays the same across fetches, in CRLF lines", () => {
  const a = feed(3, null);
  const later = reviewIcs({ uidBase: "w1-u1", blocks: reviewBlocks(TUE_THU, NOW), count: 1, nextDeadline: null, timeZone: "Europe/London", homeUrl: "https://app.example/w/w1", now: new Date(NOW.getTime() + 3_600_000) });
  const uids = (s: string) => unfold(s).match(/^UID:.*$/gm);
  expect(uids(a)).toEqual(["UID:review-w1-u1-2026-11-17@direx", "UID:review-w1-u1-2026-11-19@direx", "UID:review-w1-u1-2026-11-24@direx", "UID:review-w1-u1-2026-11-26@direx"]);
  expect(uids(later)).toEqual(uids(a));
  expect(a.endsWith("\r\n")).toBe(true);
  expect(a.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  expect(unfold(a)).toContain("DTSTART:20261117T100000Z\r\nDTEND:20261117T103000Z");
});

test("the feed holds only these properties, so nothing from a draft can reach it", () => {
  const names = new Set(unfold(feed(5, new Date("2026-11-20T00:00:00Z"))).trimEnd().split("\r\n").map((l) => l.split(/[:;]/)[0]));
  expect([...names].sort()).toEqual(
    ["BEGIN", "CALSCALE", "DESCRIPTION", "DTEND", "DTSTAMP", "DTSTART", "END", "METHOD", "PRODID", "REFRESH-INTERVAL", "SUMMARY", "TRANSP", "UID", "URL", "VERSION", "X-PUBLISHED-TTL", "X-WR-CALNAME"].sort(),
  );
  expect(unfold(feed(5, null))).toMatch(/^DESCRIPTION:Counted at Fri 13 Nov 12:00. Open Needs you: https:\/\/app.example\/w\/w1$/m);
});
