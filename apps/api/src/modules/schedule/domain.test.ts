// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { CAPS, counts, countedSlots, fits, type ReservationRow } from "./domain/caps";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-11-02T09:00:00Z").getTime();
const at = (days: number) => new Date(T0 + days * DAY);

test("a cold Touch needs 3 days either side of every counted one", () => {
  expect(fits(CAPS.general, at(3), [at(0)])).toBe(true);
  expect(fits(CAPS.general, new Date(T0 + 3 * DAY - 60_000), [at(0)])).toBe(false);
  expect(fits(CAPS.general, at(0), [at(2)])).toBe(false);
  expect(fits(CAPS.general, at(0), [at(3)])).toBe(true);
});

test("a sixth Touch in any rolling 30 days is refused, whether the others lie before, after or around it", () => {
  const before = [at(-20), at(-15), at(-10), at(-5), at(-29)];
  expect(fits(CAPS.general, at(0), before.slice(0, 4))).toBe(true);
  expect(fits(CAPS.general, at(0), before)).toBe(false);
  const after = [at(5), at(10), at(15), at(20), at(25)];
  expect(fits(CAPS.general, at(0), after)).toBe(false);
  expect(fits(CAPS.general, at(0), after.slice(0, 4))).toBe(true);
  const around = [at(-12), at(-6), at(6), at(12), at(17)];
  expect(fits(CAPS.general, at(0), around)).toBe(false);
  // Day -12 to day 18 is exactly 30 days, so no window holds all six.
  expect(fits(CAPS.general, at(0), [at(-12), at(-6), at(6), at(12), at(18)])).toBe(true);
});

test("Touches exactly 30 days apart are in different windows", () => {
  const four = [at(-30), at(-24), at(-18), at(-12)];
  // [-30, 0) holds four; any window containing day 0 lost day -30.
  expect(fits(CAPS.general, at(0), [...four, at(-6)])).toBe(true);
  expect(fits(CAPS.general, at(0), [...four, at(-6), at(6)])).toBe(true);
  expect(fits(CAPS.general, at(0), [...four, at(-6), at(5)])).toBe(false);
});

test("a touch Direx didn't send holds the gap on either side but never fills the 30 days", () => {
  expect(fits(CAPS.general, at(0), [], [at(-2)])).toBe(false);
  expect(fits(CAPS.general, at(0), [], [at(2)])).toBe(false);
  expect(fits(CAPS.general, at(0), [], [at(-3)])).toBe(true);
  expect(fits(CAPS.general, at(0), [], [at(3)])).toBe(true);
  const tenOutside = [-27, -24, -21, -18, -15, -12, -9, -6, -3, 3].map(at);
  expect(fits(CAPS.general, at(0), [], tenOutside)).toBe(true);
  // Four of Direx's own plus outside ones still leaves room for a fifth.
  expect(fits(CAPS.general, at(0), [at(-20), at(-15), at(-10), at(-5)], [at(-25), at(-13), at(4)])).toBe(true);
});

test("consented marketing allows 1 per 2 days and 8 per 30", () => {
  expect(fits(CAPS.consented_marketing, at(2), [at(0)])).toBe(true);
  const seven = [3, 6, 9, 12, 15, 18, 21].map((d) => at(-d));
  expect(fits(CAPS.consented_marketing, at(0), seven)).toBe(true);
  expect(fits(CAPS.consented_marketing, at(0), [...seven, at(4)])).toBe(false);
});

test("what still counts depends on the Action's live state", () => {
  const now = at(10);
  const old = at(8);
  expect(counts(old, { state: "sent", holdReason: null }, now)).toBe(true);
  expect(counts(old, { state: "dispatching", holdReason: null }, now)).toBe(true);
  expect(counts(old, { state: "held", holdReason: "outcome_unknown" }, now)).toBe(true);
  expect(counts(at(11), { state: "cancelled", holdReason: null }, now)).toBe(false);
  expect(counts(at(11), { state: "blocked", holdReason: "opted_out" }, now)).toBe(false);
  // Blocked on a resend after an unknown call: the first call may have gone out.
  expect(counts(at(11), { state: "blocked", holdReason: null, outcomeUnknownAt: at(10) }, now)).toBe(true);
  expect(counts(at(9.1), { state: "held", holdReason: "cap" }, now)).toBe(true);
  expect(counts(old, { state: "held", holdReason: "cap" }, now)).toBe(false);
  expect(counts(old, { state: "scheduled", holdReason: null }, now)).toBe(false);
  expect(counts(at(11), { state: "needs_approval", holdReason: null }, now)).toBe(true);
});

test("only an Action's newest reservation counts", () => {
  const rows: ReservationRow[] = [
    { actionId: "a", cap: "general", slot: at(1), createdAt: at(0) },
    { actionId: "a", cap: "general", slot: at(5), createdAt: at(2) },
    { actionId: "b", cap: "consented_marketing", slot: at(3), createdAt: at(0) },
  ];
  const states = new Map([["a", { state: "scheduled", holdReason: null }]]);
  expect(countedSlots(rows, "general", states, at(0))).toEqual([at(5)]);
  expect(countedSlots(rows, "general", states, at(0), "a")).toEqual([]);
});
