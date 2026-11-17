// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { renderIssue } from "./domain/render";
import { draftDue, gapWarning, nextSlot } from "./domain/slots";

const berlinTuesday9 = { weekday: 2, sendTime: "09:00", timeZone: "Europe/Berlin" };

test("the next Tuesday 09:00 in Berlin, from a Wednesday", () => {
  expect(nextSlot(berlinTuesday9, new Date("2026-11-04T12:00:00Z")).toISOString()).toBe("2026-11-10T08:00:00.000Z");
});

test("on the day itself: later today before the time, next week after it", () => {
  expect(nextSlot(berlinTuesday9, new Date("2026-11-10T07:00:00Z")).toISOString()).toBe("2026-11-10T08:00:00.000Z");
  expect(nextSlot(berlinTuesday9, new Date("2026-11-10T08:00:00Z")).toISOString()).toBe("2026-11-17T08:00:00.000Z");
});

test("09:00 stays 09:00 local across both clock changes", () => {
  // Berlin moves to summer time on 29 March 2026 and back on 25 October 2026.
  expect(nextSlot(berlinTuesday9, new Date("2026-03-25T12:00:00Z")).toISOString()).toBe("2026-03-31T07:00:00.000Z");
  expect(nextSlot(berlinTuesday9, new Date("2026-10-21T12:00:00Z")).toISOString()).toBe("2026-10-27T08:00:00.000Z");
});

test("a zone west of UTC rolls the day correctly", () => {
  const laFriday1730 = { weekday: 5, sendTime: "17:30", timeZone: "America/Los_Angeles" };
  expect(nextSlot(laFriday1730, new Date("2026-11-06T23:00:00Z")).toISOString()).toBe("2026-11-07T01:30:00.000Z");
});

test("Vancouver stays on UTC-7 after 1 November 2026, so 14:00 there is 21:00 UTC", () => {
  // British Columbia keeps daylight time all year from then. Bun's built-in time zone data doesn't know
  // yet; a failure here means the process started without ICU_TIMEZONE_FILES_DIR (see deploy/icu-tz).
  const vancouverFriday14 = { weekday: 5, sendTime: "14:00", timeZone: "America/Vancouver" };
  expect(nextSlot(vancouverFriday14, new Date("2026-11-08T12:00:00Z")).toISOString()).toBe("2026-11-13T21:00:00.000Z");
});

test("the draft is due two local days before, at 06:00", () => {
  expect(draftDue(new Date("2026-11-10T08:00:00Z"), "Europe/Berlin").toISOString()).toBe("2026-11-08T05:00:00.000Z");
});

test("the gap warning fires after 31 days, and never before a first issue", () => {
  const sent = new Date("2026-10-01T08:00:00Z");
  expect(gapWarning(sent, new Date("2026-11-01T08:00:00Z"))).toBe(false);
  expect(gapWarning(sent, new Date("2026-11-02T08:00:00Z"))).toBe(true);
  expect(gapWarning(null, new Date("2026-11-02T08:00:00Z"))).toBe(false);
});

test("Markdown becomes plain HTML: headings, paragraphs, lists, bold, italic and links", () => {
  const html = renderIssue("# Week 12\n\nWe **shipped** the *new* plan.\nSecond line.\n\n- one\n- two\n\n1. first\n2. second\n\nRead [the post](https://example.com/a?b=1&c=2).");
  expect(html).toBe(
    [
      "<h2>Week 12</h2>",
      "<p>We <strong>shipped</strong> the <em>new</em> plan.<br>Second line.</p>",
      "<ul><li>one</li><li>two</li></ul>",
      "<ol><li>first</li><li>second</li></ol>",
      '<p>Read <a href="https://example.com/a?b=1&amp;c=2">the post</a>.</p>',
    ].join("\n"),
  );
});

test("nothing hostile comes through", () => {
  const html = renderIssue('<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n<img src="https://evil.test/p.png">\n\n[ok](https://a.test/"onmouseover="x)');
  expect(html).not.toMatch(/<script|<img|javascript:alert\(1\)"|onmouseover="/);
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).toContain("[x](javascript:alert(1))");
  expect(html).toContain('href="https://a.test/&quot;onmouseover=&quot;x"');
});
