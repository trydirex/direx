// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { approverIdFromSession } from "../ledger/index";
import { steppedUp } from "../identity/index";
import { DOOR_KINDS, DOOR_READERS } from "./domain/catalogue";
import { hashOf, hintOf, newToken } from "./application/tokens";
import { lifetimeChoices, maxDaysFromEnv, type TokenCaller } from "./domain/tokens";

test("a token is dxt_ and 43 base64url characters, and no two are alike", () => {
  const a = newToken();
  expect(a).toHaveLength(47);
  expect(a).toMatch(/^dxt_[A-Za-z0-9_-]{43}$/);
  expect(newToken()).not.toBe(a);
});

test("the hash is SHA-256 hex, never the token; the hint is the 4 characters after the prefix", () => {
  const t = newToken();
  expect(hashOf(t)).toMatch(/^[0-9a-f]{64}$/);
  expect(hashOf(t)).toBe(hashOf(t));
  expect(hashOf(t)).not.toContain(t.slice(4));
  expect(hintOf(t)).toBe(t.slice(4, 8));
});

test("lifetimes are 7, 30 and 90 days unless a self-hosted operator allows more", () => {
  expect(lifetimeChoices(null)).toEqual([7, 30, 90]);
  expect(lifetimeChoices(91)).toEqual([7, 30, 90]);
  expect(lifetimeChoices(180)).toEqual([7, 30, 90, 180]);
  expect(lifetimeChoices(364)).toEqual([7, 30, 90, 180]);
  expect(lifetimeChoices(365)).toEqual([7, 30, 90, 180, 365]);
});

test("the longest lifetime is read once, refused on cloud and outside 91 to 365", () => {
  expect(maxDaysFromEnv(undefined, false)).toBeNull();
  expect(maxDaysFromEnv(undefined, true)).toBeNull();
  expect(maxDaysFromEnv("", false)).toBeNull();
  expect(maxDaysFromEnv("180", false)).toBe(180);
  expect(maxDaysFromEnv("365", false)).toBe(365);
  expect(() => maxDaysFromEnv("180", true)).toThrow(/DIREX_EXTERNAL_TOKEN_MAX_DAYS/);
  for (const bad of ["90", "366", "1.5", "a year", "-180"]) expect(() => maxDaysFromEnv(bad, false)).toThrow(/DIREX_EXTERNAL_TOKEN_MAX_DAYS/);
});

test("the catalogue: readers whose titles can carry contact details are personal; two kinds", () => {
  expect(Object.keys(DOOR_READERS).sort()).toEqual(["read_campaign", "read_changes", "read_needs_you", "read_schedule"]);
  expect(Object.entries(DOOR_READERS).filter(([, r]) => r.personal).map(([n]) => n).sort()).toEqual(["read_needs_you", "read_schedule"]);
  expect(DOOR_KINDS).toEqual(["fact_proposal", "draft"]);
});

test("a token's caller can't stand in for a session or an approver", () => {
  const caller: TokenCaller = { tokenId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), name: "Zapier", readers: ["read_changes"], kinds: [] };
  // @ts-expect-error a caller has no user id to approve with
  expect(() => approverIdFromSession(caller)).not.toThrow();
  // @ts-expect-error a caller has no sign-in time to step up with
  expect(() => steppedUp(caller)).toThrow();
});
