// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { diffPlans, holdKinds } from "./domain/plan-diff";

const first = { subject: "Hi {{firstName}}", text: "First text" };
const second = { subject: "Hi {{firstName}}", text: "Second text" };
const step = (key: string, more: object = {}) => ({ key, on: "2026-11-10", title: key, channelKey: "email", ...more });
const plan = (steps: ReturnType<typeof step>[], more: object = {}) => ({
  goal: "Ten demos",
  audience: "Founders",
  measures: [{ key: "demos", label: "Demos", target: "10" }],
  budget: [],
  assumptions: [],
  steps,
  ...more,
});
const none = new Map();

test("a version that only reorders steps changes nothing", () => {
  const prev = plan([step("a"), step("b")]);
  expect(diffPlans(prev, plan([step("b"), step("a")]), none)).toEqual({ steps: [], plan: [] });
});

test("added and removed steps, and a renamed key reads as both", () => {
  const d = diffPlans(plan([step("a"), step("old")]), plan([step("a"), step("new")]), none);
  expect(d.steps).toEqual([
    { key: "new", kind: "added" },
    { key: "old", kind: "removed" },
  ]);
  expect(d.steps.map(holdKinds)).toEqual([[], ["removed"]]);
});

test("dates and titles change without holding", () => {
  const d = diffPlans(plan([step("a")]), plan([step("a", { on: "2026-11-12", title: "Renamed" })]), none);
  expect(d.steps).toEqual([{ key: "a", kind: "changed", redatedDays: 2, retitled: true, channel: false, text: false }]);
  expect(holdKinds(d.steps[0]!)).toEqual([]);
});

test("a step moved earlier counts negative days", () => {
  const d = diffPlans(plan([step("a")]), plan([step("a", { on: "2026-11-01" })]), none);
  expect(d.steps[0]).toMatchObject({ redatedDays: -9 });
});

test("a changed channel holds the step", () => {
  const d = diffPlans(plan([step("a")]), plan([step("a", { channelKey: "linkedin" })]), none);
  expect(holdKinds(d.steps[0]!)).toEqual(["channel"]);
  const dropped = diffPlans(plan([step("a")]), plan([step("a", { channelKey: undefined })]), none);
  expect(dropped.steps[0]).toMatchObject({ channel: true });
});

test("new plan text is suggested only when the step already has different text", () => {
  const prev = plan([step("a", { template: first })]);
  const next = plan([step("a", { template: second })]);
  // The step owns the first text: the second is a suggestion and holds.
  const owned = diffPlans(prev, next, new Map([["a", first]]));
  expect(owned.steps[0]).toMatchObject({ text: true });
  expect(holdKinds(owned.steps[0]!)).toEqual(["text"]);
  // No text on the step yet: it takes the plan's text, nothing to suggest.
  expect(diffPlans(prev, next, none).steps).toEqual([]);
  // The person already wrote exactly the new text on the step.
  expect(diffPlans(prev, next, new Map([["a", second]])).steps).toEqual([]);
});

test("a person's own edit on the step is not re-suggested when the plan text stays the same", () => {
  const prev = plan([step("a", { template: first })]);
  const edited = { subject: "Hi", text: "My own words" };
  expect(diffPlans(prev, plan([step("a", { template: first })]), new Map([["a", edited]])).steps).toEqual([]);
});

test("plan text taken away suggests nothing", () => {
  const d = diffPlans(plan([step("a", { template: first })]), plan([step("a")]), new Map([["a", first]]));
  expect(d.steps).toEqual([]);
});

test("a step re-dated and re-texted reports both, and holds for the text", () => {
  const d = diffPlans(plan([step("a", { template: first })]), plan([step("a", { template: second, on: "2026-11-13" })]), new Map([["a", first]]));
  expect(d.steps[0]).toEqual({ key: "a", kind: "changed", redatedDays: 3, retitled: false, channel: false, text: true });
  expect(holdKinds(d.steps[0]!)).toEqual(["text"]);
});

test("plan-level changes are listed and hold nothing", () => {
  const d = diffPlans(plan([]), plan([], { goal: "Twenty demos", audience: "Agencies", budget: [{ label: "Ads" }] }), none);
  expect(d).toEqual({ steps: [], plan: ["goal", "audience", "budget"] });
});
