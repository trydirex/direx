// SPDX-License-Identifier: AGPL-3.0-only
// Pure: channel mixes of the Touches on or before an outcome, rows by People reached, and the comparison rule.
import { expect, test } from "vitest";
import { MIN_TO_COMPARE, overlapKind, withRates, type Channel, type Touch } from "./domain/overlaps";

const touch = (personId: string, on: string, channel: Channel, stepKey = channel): Touch => ({ personId, on, stepKey, title: null, channel });
const row = (channels: Channel[], reached: number, outcomes: number) => ({ channels, reached, outcomes, rate: null });

test("a mix uses only Touches on or before the outcome day; without the outcome it uses them all", () => {
  const touches = [touch("a", "2026-11-05", "linkedin_dm"), touch("a", "2026-11-01", "email"), touch("a", "2026-11-03", "x_dm"), touch("b", "2026-11-01", "email"), touch("b", "2026-11-09", "linkedin_dm")];
  const k = overlapKind(touches, new Map([["a", "2026-11-03"]]));
  expect(k.rows).toEqual([row(["email", "linkedin_dm"], 1, 0), row(["email", "x_dm"], 1, 1)]);
  // Oldest first, and only those on or before the day.
  expect(k.people).toEqual([
    {
      personId: "a",
      on: "2026-11-03",
      touches: [
        { on: "2026-11-01", stepKey: "email", title: null, channel: "email" },
        { on: "2026-11-03", stepKey: "x_dm", title: null, channel: "x_dm" },
      ],
    },
  ]);
  expect(k.more).toBe(0);
});

test("a Person with no Touch, or none by the outcome day, is in no row and not listed", () => {
  const k = overlapKind([touch("late", "2026-11-09", "email")], new Map([["late", "2026-11-02"], ["never", "2026-11-02"]]));
  expect(k).toEqual({ rows: [], people: [], more: 0 });
});

test("rows sort by People reached, ties in channel order; a Person counts once however many Touches", () => {
  const touches = [touch("a", "2026-11-01", "x_dm"), touch("b", "2026-11-01", "linkedin_dm"), touch("c", "2026-11-01", "email"), touch("c", "2026-11-02", "email"), touch("d", "2026-11-01", "email"), touch("d", "2026-11-01", "x_dm"), touch("e", "2026-11-01", "linkedin_dm")];
  expect(overlapKind(touches, new Map([["c", "2026-11-02"]])).rows).toEqual([row(["linkedin_dm"], 2, 0), row(["email"], 1, 1), row(["email", "x_dm"], 1, 0), row(["x_dm"], 1, 0)]);
});

test("one row with enough outcomes shows no rate; two show whole percents, only on those two; 9 is too few", () => {
  const n = MIN_TO_COMPARE;
  expect(withRates([row(["email"], 40, n), row(["linkedin_dm"], 30, n - 1)]).map((r) => r.rate)).toEqual([null, null]);
  expect(withRates([row(["email"], 30, n), row(["email", "linkedin_dm"], 15, n + 1), row(["x_dm"], 12, n - 1)]).map((r) => r.rate)).toEqual([33, 73, null]);
});

test("People are listed oldest outcome first, cut at the cap with the rest counted in more", () => {
  const ids = ["p3", "p1", "p2"];
  const k = overlapKind(ids.map((p) => touch(p, "2026-11-01", "email")), new Map([["p3", "2026-11-04"], ["p1", "2026-11-02"], ["p2", "2026-11-02"]]), 2);
  expect(k.people.map((p) => p.personId)).toEqual(["p1", "p2"]);
  expect(k.more).toBe(1);
  expect(k.rows).toEqual([row(["email"], 3, 3)]);
});
