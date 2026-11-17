// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { datedSteps, decideBy, stallChoices, stallDue, stepDate } from "./domain/anchor";

const plan = { planStartsOn: "2026-11-10" };

test("a step keeps its distance from the launch, whichever way the launch moves", () => {
  expect(stepDate({ ...plan, stepOn: "2026-11-13", anchorOn: "2026-11-10" })).toBe("2026-11-13");
  expect(stepDate({ ...plan, stepOn: "2026-11-13", anchorOn: "2026-11-13" })).toBe("2026-11-16");
  expect(stepDate({ ...plan, stepOn: "2026-11-13", anchorOn: "2026-11-07" })).toBe("2026-11-10");
  // A step before the launch stays before it, across a month end.
  expect(stepDate({ ...plan, stepOn: "2026-11-08", anchorOn: "2026-12-01" })).toBe("2026-11-29");
});

test("an output that comes early never pulls a step ahead, and one that comes late pushes it back", () => {
  expect(stepDate({ ...plan, stepOn: "2026-11-13", anchorOn: "2026-11-10", outputOn: "2026-11-08" })).toBe("2026-11-13");
  expect(stepDate({ ...plan, stepOn: "2026-11-13", anchorOn: "2026-11-10", outputOn: "2026-11-12" })).toBe("2026-11-15");
  expect(stepDate({ ...plan, stepOn: "2026-11-13", anchorOn: "2026-11-10", outputOn: null })).toBe("2026-11-13");
});

test("decide-by is a working day before the first send, less the days drafting takes", () => {
  // Wednesday 09:00 in London: approve by Tuesday 09:00.
  expect(decideBy({ firstSlot: new Date("2026-11-11T09:00:00Z"), draftingDays: 0, timeZone: "Europe/London" })).toEqual(new Date("2026-11-10T09:00:00Z"));
  // Monday's send skips the weekend back to Friday.
  expect(decideBy({ firstSlot: new Date("2026-11-16T09:00:00Z"), draftingDays: 0, timeZone: "Europe/London" })).toEqual(new Date("2026-11-13T09:00:00Z"));
  // Two days of drafting come before the approval day.
  expect(decideBy({ firstSlot: new Date("2026-11-11T09:00:00Z"), draftingDays: 2, timeZone: "Europe/London" })).toEqual(new Date("2026-11-08T09:00:00Z"));
  // Across the clock change the local time stays 09:00: Monday 26 Oct 09:00 GMT gives Friday 23 Oct 09:00 BST.
  expect(decideBy({ firstSlot: new Date("2026-10-26T09:00:00Z"), draftingDays: 0, timeZone: "Europe/London" })).toEqual(new Date("2026-10-23T08:00:00Z"));
});

test("going ahead is offered only when no waiting step's text uses the missing output", () => {
  expect(stallChoices([{ key: "email", usesOutput: false }, { key: "post", usesOutput: false }])).toEqual(["wait", "go_ahead", "cancel"]);
  expect(stallChoices([{ key: "email", usesOutput: true }, { key: "post", usesOutput: false }])).toEqual(["wait", "cancel"]);
});

test("a step with no output stalls 3 days after its date, and keep waiting asks again 3 days later", () => {
  const base = { dependencyOn: "2026-11-10", hasOutput: false };
  expect(stallDue({ ...base, today: "2026-11-12" })).toBe(false);
  expect(stallDue({ ...base, today: "2026-11-13" })).toBe(true);
  expect(stallDue({ ...base, hasOutput: true, today: "2026-11-20" })).toBe(false);
  expect(stallDue({ ...base, today: "2026-11-15", waitingSince: "2026-11-13" })).toBe(false);
  expect(stallDue({ ...base, today: "2026-11-16", waitingSince: "2026-11-13" })).toBe(true);
});

test("dated steps follow the launch, and with no launch set keep the plan's own dates", () => {
  const plan = { startsOn: "2026-11-10", steps: [{ key: "a", on: "2026-11-10" }, { key: "b", on: "2026-11-17" }] };
  expect(datedSteps(plan, null)).toEqual(plan.steps);
  expect(datedSteps(plan, "2026-11-13").map((s) => s.on)).toEqual(["2026-11-13", "2026-11-20"]);
});
