// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { defaultModes, draftingPreview, followUpsDue, stepProgress, waitingTitle, type Caps } from "./domain/timing";

const caps: Caps = { agentLeftToday: 100, agentPerDay: 100, workspaceLeftToday: 300, workspacePerDay: 300 };

test("the first email is per Person when outside content is allowed, and every follow-up is a template", () => {
  const steps = [{ key: "post", email: false }, { key: "first", email: true }, { key: "nudge", email: true }];
  expect(defaultModes(steps, true)).toEqual({ first: "per_person", nudge: "template" });
  expect(defaultModes(steps, false)).toEqual({ first: "template", nudge: "template" });
});

test("the import preview counts two runs a Person, the worst-case cost, and the days the caps make it take", () => {
  expect(draftingPreview({ ready: 200, mode: "per_person", costCapCents: 100, caps, today: "2026-11-09" })).toEqual({ people: 200, runs: 400, worstCaseCents: 40_000, days: 2, readyOn: "2026-11-10" });
  // A subscription has no price, and runs already spent today push the end out.
  expect(draftingPreview({ ready: 150, mode: "per_person", costCapCents: null, caps: { ...caps, agentLeftToday: 20 }, today: "2026-11-09" })).toMatchObject({ worstCaseCents: null, days: 3, readyOn: "2026-11-11" });
  // What other agents spent today leaves the Workspace room for 25 People, so 100 take two days.
  expect(draftingPreview({ ready: 100, mode: "per_person", costCapCents: 100, caps: { ...caps, workspaceLeftToday: 50 }, today: "2026-11-09" })).toMatchObject({ days: 2 });
  expect(draftingPreview({ ready: 200, mode: "template", costCapCents: 100, caps, today: "2026-11-09" })).toEqual({ people: 200, runs: 0, worstCaseCents: 0, days: 1, readyOn: "2026-11-09" });
  expect(draftingPreview({ ready: 5, mode: "per_person", costCapCents: 100, caps: { agentLeftToday: 0, agentPerDay: 0, workspaceLeftToday: 0, workspacePerDay: 0 }, today: "2026-11-09" })).toMatchObject({ days: null, readyOn: null });
});

test("a per-Person follow-up is due 2 days before its date, only for People still waiting on it", () => {
  const steps = [
    { key: "first", on: "2026-11-09", mode: "per_person" as const, email: true },
    { key: "nudge", on: "2026-11-16", mode: "per_person" as const, email: true },
    { key: "last", on: "2026-11-23", mode: "template" as const, email: true },
  ];
  const none = new Set<string>();
  const people = [
    { personId: "a", replied: false, stopped: false, drafted: none },
    { personId: "b", replied: true, stopped: false, drafted: none },
    { personId: "c", replied: false, stopped: true, drafted: none },
    { personId: "d", replied: false, stopped: false, drafted: new Set(["nudge"]) },
  ];
  expect(followUpsDue(steps, people, "2026-11-13")).toEqual([]);
  expect(followUpsDue(steps, people, "2026-11-14")).toEqual([{ stepKey: "nudge", personIds: ["a"] }]);
  // The first email and template steps are never drafted here.
  expect(followUpsDue(steps, people, "2026-11-30").map((d) => d.stepKey)).toEqual(["nudge"]);
});

test("the waiting-on title names the owner and only what a person can fix", () => {
  const output = { kind: "step_output" as const, label: "the landing page" };
  expect(waitingTitle("Dana", [output, output, output, { kind: "no_eligibility" }, { kind: "daily_cap" }])).toBe("Dana's Campaign: 3 People waiting on the landing page, 1 Person waiting on eligibility");
  expect(waitingTitle("Dana", [{ kind: "daily_cap" }])).toBeNull();
});

test("a step's progress counts what's written, the day the rest is ready, and what blocks the others", () => {
  expect(stepProgress({ written: 42, toWrite: 150, days: 3, today: "2026-11-09", people: 200, notEligible: 8, blocked: null })).toMatchObject({ written: 42, toWrite: 150, readyOn: "2026-11-11", waiting: [{ label: "eligibility", count: 8 }] });
  // A step with no Mailbox writes nothing: everyone not yet written waits on it.
  expect(stepProgress({ written: 0, toWrite: 0, days: 1, today: "2026-11-09", people: 5, notEligible: 0, blocked: { kind: "no_mailbox" } })).toMatchObject({ toWrite: 0, readyOn: null, waiting: [{ label: "a Mailbox for the step", count: 5 }] });
  expect(stepProgress({ written: 2, toWrite: 0, days: 1, today: "2026-11-09", people: 5, notEligible: 0, blocked: { kind: "step_output", label: "Publish the page" } }).waiting).toEqual([{ label: "Publish the page", count: 3 }]);
  expect(stepProgress({ written: 5, toWrite: 0, days: 1, today: "2026-11-09", people: 5, notEligible: 0, blocked: null })).toMatchObject({ readyOn: null, waiting: [] });
});
