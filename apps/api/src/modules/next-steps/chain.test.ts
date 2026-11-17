// SPDX-License-Identifier: AGPL-3.0-only
// The link table's pure rules: one target per link, the card's words, its work area and the zone check.
import { expect, test } from "vitest";
import { isTimeZone, targetOf, titleOf, workAreaOf, type NextStep } from "./domain/chain";

const templates: NextStep = { link: "plan_to_templates", campaignId: "c1", planId: "p1", planVersion: 2, stepKeys: ["first", "second"] };
const drafts: NextStep = { link: "template_to_drafts", campaignId: "c1", stepKey: "first", templateRevision: 3 };

test("a target names its link and what it is for, so two steps or two links never share one", () => {
  expect(targetOf(templates)).toBe("plan_to_templates:c1");
  expect(targetOf({ ...templates, planVersion: 3 })).toBe(targetOf(templates));
  expect(targetOf(drafts)).toBe("template_to_drafts:c1:first");
  expect(targetOf({ ...drafts, stepKey: "second" })).not.toBe(targetOf(drafts));
});

test("the card says what starts, counting steps and People", () => {
  expect(titleOf(templates, { campaign: "Q4" })).toBe("Draft the text for 2 steps in Q4");
  expect(titleOf({ ...templates, stepKeys: ["first"] }, { campaign: "Q4" })).toBe("Draft the text for 1 step in Q4");
  expect(titleOf(drafts, { campaign: "Q4", step: "First email", people: 42 })).toBe("Make drafts for First email in Q4: 42 People");
  expect(titleOf(drafts, { campaign: "Q4", people: 1 })).toBe("Make drafts for first in Q4: 1 Person");
});

test("only post steps make it social work", () => {
  expect(workAreaOf(["post"])).toBe("social");
  expect(workAreaOf(["post", "email"])).toBe("outreach");
  expect(workAreaOf(["email"])).toBe("outreach");
  expect(workAreaOf([])).toBe("outreach");
});

test("a time zone must be one the runtime knows", () => {
  expect(isTimeZone("Europe/London")).toBe(true);
  expect(isTimeZone("America/Argentina/Buenos_Aires")).toBe(true);
  expect(isTimeZone("Mars/Olympus")).toBe(false);
  expect(isTimeZone("")).toBe(false);
});
