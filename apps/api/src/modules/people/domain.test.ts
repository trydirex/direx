// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { normaliseKey } from "./application/keys";
import { groupIds } from "./domain/groups";

test("a chain of links is one group named by its lowest id; a rejected link is simply absent", () => {
  const g = groupIds(["c", "a", "b", "d"], [["a", "b"], ["b", "c"]]);
  expect(Object.fromEntries(g)).toEqual({ a: "a", b: "a", c: "a", d: "d" });
  const split = groupIds(["a", "b", "c"], [["b", "c"]]);
  expect(Object.fromEntries(split)).toEqual({ a: "a", b: "b", c: "b" });
});

test("links to records outside the list are ignored", () => {
  expect(Object.fromEntries(groupIds(["b"], [["a", "b"]]))).toEqual({ b: "b" });
});

test("keys are normalised so the same address always compares equal", () => {
  expect(normaliseKey("email", "  Dana.Lee@Example.COM ")).toEqual({ ok: true, value: "dana.lee@example.com" });
  expect(normaliseKey("phone", "(415) 555-0100", { defaultCountry: "US" })).toEqual(normaliseKey("phone", "+1 415 555 0100"));
  expect(normaliseKey("phone", "+1 415 555 0100")).toEqual({ ok: true, value: "+14155550100" });
  expect(normaliseKey("linkedin", "linkedin.com/in/Dana-Lee/?utm=x")).toEqual({
    ok: true,
    value: "https://www.linkedin.com/in/dana-lee",
  });
  expect(normaliseKey("linkedin", "https://de.linkedin.com/in/dana-lee")).toEqual(normaliseKey("linkedin", "https://www.linkedin.com/in/DANA-LEE/"));
  expect(normaliseKey("hubspot", " 123 ")).toEqual({ ok: true, value: "123" });
  const x = { ok: true, value: "https://x.com/dana_lee" };
  for (const raw of ["@Dana_Lee", "dana_lee", "https://x.com/Dana_Lee", "twitter.com/dana_lee/", "https://mobile.twitter.com/dana_lee?s=20", "www.x.com/dana_lee"]) expect(normaliseKey("x", raw)).toEqual(x);
});

test("what can't be normalised is refused with a reason", () => {
  expect(normaliseKey("email", "dana")).toMatchObject({ ok: false });
  expect(normaliseKey("phone", "555-0100")).toEqual({ ok: false, reason: "a phone number without + needs a default country" });
  expect(normaliseKey("phone", "+1 000")).toEqual({ ok: false, reason: "not a valid phone number" });
  expect(normaliseKey("linkedin", "https://example.com/in/dana")).toMatchObject({ ok: false });
  expect(normaliseKey("shopify", "  ")).toMatchObject({ ok: false });
  for (const raw of ["https://example.com/dana", "x.com/dana/status/1", "this_handle_is_too_long", "da na", ""]) expect(normaliseKey("x", raw)).toMatchObject({ ok: false });
});
