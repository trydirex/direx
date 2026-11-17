// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { addSighting, factSource, factValue, linesOf, MAX_FACT_CHARS, movePayload, moveTitle, rootOf, type Sighting } from "./domain/moves";

const READ = "2026-11-16T07:00:00.000Z";
const sighting = (changeId: string): Sighting => ({
  changeId,
  source: "changelog",
  lines: ["Autoclose: AI agents reconcile accounts"],
  before: { id: "s1", readAt: "2026-11-09T07:00:00.000Z" },
  after: { id: "s2", readAt: READ, url: "https://double.example/changelog" },
});

test("the root of a sameAs chain of 1, 2 and 3; a cycle throws", () => {
  const sameAs = new Map<string, string | null>([
    ["a", null],
    ["b", "a"],
    ["c", "b"],
    ["x", "y"],
    ["y", "x"],
  ]);
  expect(rootOf("a", sameAs)).toBe("a");
  expect(rootOf("b", sameAs)).toBe("a");
  expect(rootOf("c", sameAs)).toBe("a");
  expect(() => rootOf("x", sameAs)).toThrow(/cycle/);
});

test("lines read as on the page: pricing removals say so, landing gives the part, a rewrite its counts", () => {
  expect(linesOf({ added: ["Enterprise"], removed: ["Even more from Double"] })).toEqual(["Enterprise", "Removed: Even more from Double"]);
  expect(linesOf({ part: "headline", before: "Old", after: "Your fully automated close is here." })).toEqual(["headline: Your fully automated close is here."]);
  expect(linesOf({ part: "subhead", before: "Old", after: null })).toEqual(["subhead: (gone)"]);
  expect(linesOf({ rewritten: { added: 40, removed: 3 } })).toEqual(["Page rewritten: 40 lines added, 3 removed"]);
});

test("a Fact value names the page and the read date and quotes the lines", () => {
  expect(factValue("pricing", READ, { added: ["Enterprise", "Contact sales"], removed: ["Scale $45"] })).toBe("pricing page, read 16 Nov 2026: Enterprise; Contact sales; Removed: Scale $45");
  expect(factValue("changelog", READ, { added: ["Group Undeposited Funds\ninto a deposit"] })).toBe("changelog page, read 16 Nov 2026: Group Undeposited Funds into a deposit");
});

test("a long Fact value keeps whole lines from the top, within the cap", () => {
  const lines = Array.from({ length: 40 }, (_, n) => `Line ${n} ${"x".repeat(40)}`);
  const v = factValue("changelog", READ, { added: lines });
  expect(v.length).toBeLessThanOrEqual(MAX_FACT_CHARS);
  expect(v).toContain("Line 0 ");
  expect(v).not.toContain("Line 39 ");
  expect(v.endsWith("x")).toBe(true);
});

test("the Fact source is the page as read", () => {
  expect(factSource("Double", "pricing", { id: "s2", readAt: READ, url: "https://double.example/pricing" })).toEqual({
    kind: "website",
    label: "Double pricing page",
    url: "https://double.example/pricing",
    retrievedAt: READ,
  });
});

test("titles are fixed phrases plus the competitor's first line, cut at 60 characters", () => {
  expect(moveTitle("comparison_page", "Double", "anything")).toBe("Update your Double comparison page");
  expect(moveTitle("post", "Xenett", "GL Rec, All Clients")).toBe("Post about Xenett: GL Rec, All Clients");
  const long = moveTitle("post", "Xenett", `${"word ".repeat(30)}\nend`);
  expect(long.length).toBeLessThanOrEqual("Post about Xenett: ".length + 60);
  expect(long.endsWith("…")).toBe(true);
  expect(moveTitle("post", "Xenett", undefined)).toBe("Post about Xenett");
});

test("a payload starts with one sighting; a new sighting is added once", () => {
  const p = movePayload("comparison_page", { id: "c1", name: "Double" }, "https://us.example/vs-double", "Price change", sighting("a"));
  expect(p).toMatchObject({ schemaVersion: 1, move: "comparison_page", target: "https://us.example/vs-double", brief: null, briefRunId: null, briefNote: null });
  const two = addSighting(p, sighting("b"));
  expect(two.sightings.map((s) => s.changeId)).toEqual(["a", "b"]);
  expect(addSighting(two, sighting("b"))).toBe(two);
});
