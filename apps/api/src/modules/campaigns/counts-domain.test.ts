// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { nextReading, stepFunnel, sumBy, tally, type FunnelStep } from "./domain/counts";

const step = (stepKey: string, type: string, dmChannel: string | null = null): FunnelStep => ({ stepKey, title: stepKey, type, dmChannel });
const none = new Map<string, number>();
const counts = (over: Partial<Parameters<typeof stepFunnel>[1]> = {}) => ({ emails: none, dms: none, posts: none, replied: none, interested: none, ...over });

test("a count becomes a reading only when it could be counted and it moved", () => {
  expect(nextReading(0, false, null)).toBeNull();
  expect(nextReading(0, true, null)).toBe("0");
  expect(nextReading(3, true, "3")).toBeNull();
  expect(nextReading(4, true, "3")).toBe("4");
});

test("rows add up by their key, and pairs count each Person once across steps", () => {
  expect(sumBy([{ k: "a", n: 1 }, { k: "b", n: 2 }, { k: "a", n: 3 }], "k")).toEqual(new Map([["a", 4], ["b", 2]]));
  const t = tally([{ stepKey: "one", personId: "p" }, { stepKey: "two", personId: "p" }, { stepKey: "one", personId: "q" }]);
  expect(t.byStep).toEqual(new Map([["one", 2], ["two", 1]]));
  expect(t.people).toBe(2);
});

test("an email step with nothing sent has no reply numbers, not zeros; once one goes, they count from zero", () => {
  expect(stepFunnel([step("e", "email")], counts())).toEqual([{ stepKey: "e", title: "e", kind: "email", channel: "email", sent: { n: 0, source: "direx" }, replied: null, interested: null }]);
  const [sent] = stepFunnel([step("e", "email")], counts({ emails: new Map([["e", 2]]), replied: new Map([["e", 1]]) }));
  expect(sent).toMatchObject({ sent: { n: 2, source: "direx" }, replied: { n: 1, source: "direx" }, interested: { n: 0, source: "direx" } });
});

test("a DM's sends are a person's word, a post's are Direx's, neither has replies, and other steps count nothing", () => {
  const rows = stepFunnel([step("d", "dm", "linkedin"), step("p", "post"), step("m", "manual")], counts({ dms: new Map([["d", 3]]), posts: new Map([["p", 1]]), replied: new Map([["d", 1], ["p", 1]]) }));
  expect(rows).toEqual([
    { stepKey: "d", title: "d", kind: "dm", channel: "linkedin", sent: { n: 3, source: "person" }, replied: null, interested: null },
    { stepKey: "p", title: "p", kind: "post", channel: null, sent: { n: 1, source: "direx" }, replied: null, interested: null },
    { stepKey: "m", title: "m", kind: "manual", channel: null, sent: null, replied: null, interested: null },
  ]);
});
