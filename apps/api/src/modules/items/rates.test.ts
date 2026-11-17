// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { reviewRates, type ReviewDecision } from "./domain/rates";

const at = new Date("2026-11-10T09:00:00Z");
/** `n` decisions taking `secs` each, every `every`th one edited. */
const run = (n: number, secs: number, every: number): ReviewDecision[] =>
  Array.from({ length: n }, (_, i) => ({ decision: i % every === 0 ? "edit_approve" : "approve", openedAt: new Date(at.getTime() - secs * 1000), decidedAt: at }));

test("no decisions, no rates", () => {
  expect(reviewRates([])).toEqual({ decisions: 0, medianSeconds: null, changedShare: null, warning: false });
});

test("rates come from the newest 50", () => {
  expect(reviewRates([...run(50, 10, 5), ...run(50, 40, 2)])).toMatchObject({ decisions: 50, medianSeconds: 10, changedShare: 0.2 });
});

test("faster by half and changing half as often warns", () => {
  expect(reviewRates([...run(50, 10, 5), ...run(50, 20, 2)]).warning).toBe(true);
});

test("faster alone, or changing less alone, doesn't warn", () => {
  expect(reviewRates([...run(50, 10, 2), ...run(50, 20, 2)]).warning).toBe(false);
  expect(reviewRates([...run(50, 20, 5), ...run(50, 20, 2)]).warning).toBe(false);
  // Just short of half as fast.
  expect(reviewRates([...run(50, 11, 5), ...run(50, 20, 2)]).warning).toBe(false);
});

test("fewer than 100 decisions never warn", () => {
  expect(reviewRates([...run(50, 1, 50), ...run(49, 60, 2)]).warning).toBe(false);
});
