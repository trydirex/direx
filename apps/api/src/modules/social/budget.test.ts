// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { CEILING, CLEAN_DAYS_PER_STEP, ESTABLISHED, FLOOR, atFloor, capOf, halve, overBudget, spendOf, step, type Budget } from "./domain/budget";

test("an established account starts above the floor and inside the ceiling, and only the floor counts as at the floor", () => {
  for (const k of ["posts", "replies", "links"] as const) {
    expect(ESTABLISHED[k]).toBeGreaterThan(FLOOR[k]);
    expect(ESTABLISHED[k]).toBeLessThanOrEqual(CEILING[k]);
  }
  expect(atFloor(FLOOR)).toBe(true);
  expect(atFloor(ESTABLISHED)).toBe(false);
  expect(atFloor({ ...FLOOR, links: 1 })).toBe(false);
});

test("a new account climbs one step per run of clean days and stops at the ceiling", () => {
  let b: Budget = FLOOR;
  for (let week = 0; week < 60; week++) b = step(b, CLEAN_DAYS_PER_STEP, null);
  expect(b).toEqual(CEILING);
  expect(step(FLOOR, CLEAN_DAYS_PER_STEP - 1, null)).toEqual(FLOOR);
  expect(step(FLOOR, CLEAN_DAYS_PER_STEP, null)).toEqual({ posts: 2, replies: 4, links: 1 });
});

test("a person's lower limit caps the climb, and can't lift the ceiling", () => {
  let b: Budget = FLOOR;
  for (let week = 0; week < 60; week++) b = step(b, CLEAN_DAYS_PER_STEP, { links: 1 });
  expect(b).toEqual({ ...CEILING, links: 1 });
  expect(capOf({ posts: 50 })).toEqual(CEILING);
});

test("halving rounds down and never drops below the floor", () => {
  expect(halve(CEILING)).toEqual({ posts: 2, replies: 10, links: 1 });
  expect(halve(FLOOR)).toEqual(FLOOR);
});

test("a post with a link spends a post and a link; follow-ups spend replies", () => {
  expect(spendOf({ text: "plain" })).toEqual({ posts: 1, replies: 0, links: 0 });
  expect(spendOf({ text: "see https://acme.test/x", followUps: ["more"] })).toEqual({ posts: 1, replies: 1, links: 1 });
  expect(spendOf({ text: "plain", followUps: ["read http://acme.test"] }).links).toBe(1);
});

test("a post is over budget on the first of posts or links it would pass; replies aren't enforced", () => {
  const b = { posts: 2, replies: 0, links: 1 };
  const none = { posts: 0, replies: 0, links: 0 };
  expect(overBudget(b, none, { posts: 1, replies: 5, links: 1 })).toBeNull();
  expect(overBudget(b, { posts: 2, replies: 0, links: 0 }, { posts: 1, replies: 0, links: 0 })).toEqual({ key: "posts", used: 2, budget: 2 });
  expect(overBudget(b, { posts: 1, replies: 0, links: 1 }, { posts: 1, replies: 0, links: 1 })).toEqual({ key: "links", used: 1, budget: 1 });
  expect(overBudget(FLOOR, none, { posts: 1, replies: 0, links: 1 })).toEqual({ key: "links", used: 0, budget: 0 });
});
