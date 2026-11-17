// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { DEFAULT_PACE, countedOn, insideHours, mailboxDay, plan } from "./domain/mailbox";

const ZONE = "Europe/Berlin";

test("500 a day fits inside 09:00 to 17:00 on one day, evenly spaced", () => {
  const pace = { ...DEFAULT_PACE, dailyLimit: 500 };
  const times = plan({ on: "2026-11-10", count: 500, pace, timeZone: ZONE });
  expect(times).toHaveLength(500);
  expect(new Set(times.map((t) => mailboxDay(t, ZONE)))).toEqual(new Set(["2026-11-10"]));
  expect(times[0]!.toISOString()).toBe("2026-11-10T08:00:00.000Z");
  expect(times.every((t) => insideHours(t, pace, ZONE))).toBe(true);
  // 480 minutes over 500 sends.
  expect(times[1]!.getTime() - times[0]!.getTime()).toBe(57_600);
});

test("a day takes the limit after what it already has, and weekends wait unless the Mailbox sends on them", () => {
  // Friday 13 Nov has 49 of 50 taken: one there, then Monday.
  const times = plan({ on: "2026-11-13", count: 3, pace: DEFAULT_PACE, timeZone: "UTC", taken: { "2026-11-13": 49 } });
  expect(times.map((t) => mailboxDay(t, "UTC"))).toEqual(["2026-11-13", "2026-11-16", "2026-11-16"]);
  const weekend = plan({ on: "2026-11-14", count: 1, pace: { ...DEFAULT_PACE, sendWeekends: true }, timeZone: "UTC" });
  expect(mailboxDay(weekend[0]!, "UTC")).toBe("2026-11-14");
  expect(insideHours(new Date("2026-11-13T17:00:00Z"), DEFAULT_PACE, "UTC")).toBe(false);
});

test("a day counts each Action's newest reservation only, and only while its Action counts", () => {
  const now = new Date("2026-11-10T07:00:00Z");
  const slot = new Date("2026-11-10T09:00:00Z");
  const rows = [
    { actionId: "a", day: "2026-11-10", slot, createdAt: new Date(1) },
    { actionId: "b", day: "2026-11-10", slot, createdAt: new Date(1) },
    { actionId: "c", day: "2026-11-10", slot, createdAt: new Date(1) },
  ];
  const states = new Map([
    ["a", { state: "scheduled", holdReason: null }],
    ["b", { state: "cancelled", holdReason: null }],
    ["c", { state: "draft", holdReason: null }],
  ]);
  expect(countedOn("2026-11-10", rows, states, now)).toBe(2);
  expect(countedOn("2026-11-10", rows, states, now, "a")).toBe(1);
  expect(countedOn("2026-11-11", rows, states, now)).toBe(0);
});
