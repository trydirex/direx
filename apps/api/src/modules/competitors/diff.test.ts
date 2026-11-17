// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { changelogChange, landingChanges, pricingChange, REWRITE_LINES } from "./domain/diff";
import type { LandingParts } from "./domain/parts";

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i}`);

test("a changelog's added lines are its Change; moved or dropped lines are none", () => {
  const before = ["October 29, 2026", "Autoclose: AI agents reconcile accounts.", "October 22, 2026", "Teams connection"];
  const after = ["November 5, 2026", "Bank reconciliation now auto-matches transfers", ...before.slice(0, 2)];
  expect(changelogChange(before, after)).toEqual({ added: ["November 5, 2026", "Bank reconciliation now auto-matches transfers"] });
  expect(changelogChange(before, [...before].reverse())).toBeNull();
  expect(changelogChange(before, before.slice(0, 2))).toBeNull();
});

test("pricing records lines added and removed", () => {
  const before = ["Core", "$10 per client", "Plus", "$25 per client"];
  expect(pricingChange(before, ["Core", "$12 per client", "Plus", "$25 per client", "Enterprise"])).toEqual({ added: ["$12 per client", "Enterprise"], removed: ["$10 per client"] });
  expect(pricingChange(before, [...before].reverse())).toBeNull();
});

test(`more than ${REWRITE_LINES} changed lines that are over half the page is one "page rewritten" Change`, () => {
  expect(changelogChange([], lines(REWRITE_LINES))).toEqual({ added: lines(REWRITE_LINES) });
  expect(changelogChange([], lines(REWRITE_LINES + 1))).toEqual({ rewritten: { added: REWRITE_LINES + 1, removed: 0 } });
  expect(pricingChange(lines(20, "old"), lines(11, "new"))).toEqual({ rewritten: { added: 11, removed: 20 } });
});

test("a long weekly entry on a long changelog stays line by line (Double: ~40 of ~500 lines)", () => {
  const old = lines(460, "old");
  const entry = lines(40, "new");
  expect(changelogChange(old, [...entry, ...old])).toEqual({ added: entry });
});

const page = (headline: string, over: Partial<LandingParts> = {}): LandingParts => ({ title: "Double", description: "Close faster", headline, subhead: "AI agents", ...over });

test("a landing part that changes is one Change with its old and new value", () => {
  expect(landingChanges([page("Close in half the time")], page("Your fully automated close is here.", { title: "Double: Autoclose" }))).toEqual([
    { part: "title", before: "Double", after: "Double: Autoclose" },
    { part: "headline", before: "Close in half the time", after: "Your fully automated close is here." },
  ]);
  expect(landingChanges([page("Same")], page("Same"))).toEqual([]);
  expect(landingChanges([], page("First read"))).toEqual([]);
});

test("a headline back to its value of 3 weeks ago is a flip, of 5 weeks ago is news (E3)", () => {
  const history = [page("B"), page("C"), page("A")]; // newest first: A was 3 reads ago
  expect(landingChanges(history, page("A"))).toEqual([]);
  const long = [page("B"), page("C"), page("D"), page("E"), page("A")]; // A was 5 reads ago
  expect(landingChanges(long, page("A"))).toEqual([{ part: "headline", before: "B", after: "A" }]);
});

test("a part that goes missing is a Change to null", () => {
  expect(landingChanges([page("A")], page("A", { subhead: null }))).toEqual([{ part: "subhead", before: "AI agents", after: null }]);
});
