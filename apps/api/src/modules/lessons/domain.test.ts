// SPDX-License-Identifier: AGPL-3.0-only
// The words a lesson may have, the budget and the set digest.
import { expect, test } from "vitest";
import { setDigest } from "./application/digest";
import { fitsBudget, LESSON_BUDGET_CHARS, lessonText, MAX_LESSON_CHARS } from "./domain/lessons";

test("a lesson is one trimmed line, not empty and not too long", () => {
  expect(lessonText("  First emails here\n run short. ")).toEqual({ ok: true, text: "First emails here run short." });
  expect(lessonText(" \n ")).toEqual({ ok: false, reason: "lesson_empty" });
  expect(lessonText("x".repeat(MAX_LESSON_CHARS))).toMatchObject({ ok: true });
  expect(lessonText("x".repeat(MAX_LESSON_CHARS + 1))).toEqual({ ok: false, reason: "lesson_too_long" });
});

test("the budget counts every live lesson, and a rewrite counts its new words only", () => {
  const live = [{ id: "a", text: "x".repeat(LESSON_BUDGET_CHARS - 100) }];
  expect(fitsBudget(live, "y".repeat(100))).toBe(true);
  expect(fitsBudget(live, "y".repeat(101))).toBe(false);
  expect(fitsBudget(live, "y".repeat(LESSON_BUDGET_CHARS), "a")).toBe(true);
  expect(fitsBudget([], "y".repeat(LESSON_BUDGET_CHARS + 1))).toBe(false);
});

test("the set digest ignores order, changes with any version, and is empty for none", () => {
  const a = { lessonId: "a", version: 1, text: "one" };
  const b = { lessonId: "b", version: 2, text: "two" };
  expect(setDigest([])).toBe("");
  expect(setDigest([a, b])).toBe(setDigest([b, a]));
  expect(setDigest([a, b])).not.toBe(setDigest([a, { ...b, version: 3 }]));
  expect(setDigest([a])).toMatch(/^[0-9a-f]{64}$/);
});
