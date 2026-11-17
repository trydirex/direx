// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { waitFrom } from "./http";

const now = 1_793_824_000_000;

test("a reset given as a Unix time waits until then", () => {
  expect(waitFrom(new Headers({ "ratelimit-reset": "1793824140" }), now, 60_000)).toBe(140_000);
});

test("a reset given in seconds waits that long", () => {
  expect(waitFrom(new Headers({ "retry-after": "30" }), now, 60_000)).toBe(30_000);
});

test("no header, or nonsense, uses the fallback", () => {
  expect(waitFrom(new Headers(), now, 60_000)).toBe(60_000);
  expect(waitFrom(new Headers({ "retry-after": "soon" }), now, 60_000)).toBe(60_000);
});

test("a reset already past waits nothing", () => {
  expect(waitFrom(new Headers({ "ratelimit-reset": "1793823000" }), now, 60_000)).toBe(0);
});
