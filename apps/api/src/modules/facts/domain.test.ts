// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { checkCitation } from "./domain/citation";
import { bannedIn } from "./domain/claims";
import { sameWords, saysTheSame, subjectOf } from "./domain/slots";
import { exampleText, fits, MAX_EXAMPLE_CHARS, MAX_EXAMPLES, MAX_SWAP_CHARS, MAX_SWAPS, swapWords } from "./domain/voice";

test("a single-value field has no subject, and a many-value field falls back to its words", () => {
  expect(subjectOf("tone", "anything", "Plain")).toBe("");
  expect(subjectOf("price", " Per  Audit ", "$4,500")).toBe("per audit");
  expect(subjectOf("claim", undefined, "Saved  Acme 120 hours")).toBe("saved acme 120 hours");
});

test("spacing alone doesn't make two values different; anything else does", () => {
  expect(sameWords(" From $4,500 ", "From  $4,500")).toBe(true);
  expect(sameWords("From $4,500", "from $4,500")).toBe(false);
});

test("each citation result", () => {
  const f = { currentVersion: 2, retired: false, contested: false };
  expect(checkCitation(2, f)).toBe("ok");
  expect(checkCitation(1, f)).toBe("stale");
  expect(checkCitation(2, undefined)).toBe("missing");
  expect(checkCitation(2, { ...f, retired: true })).toBe("retired");
  expect(checkCitation(2, { ...f, contested: true })).toBe("needs_decision");
});

test.each([
  ["We offer GUARANTEED ROI on every audit", true],
  ["guaranteed   roi", true],
  ["Is this guaranteed ROI?", true],
  // Matches words, not meaning: a person reads this one.
  ["we never promise guaranteed ROI", true],
])("a banned phrase is found: %s", (text, found) => {
  expect(bannedIn(text, ["Guaranteed ROI"]).length > 0).toBe(found);
});

test.each(["guaranteed ROIs", "unguaranteed ROI", "guaranteed returns on ROI", "ROI guaranteed", ""])("a near miss isn't: %s", (text) => {
  expect(bannedIn(text, ["Guaranteed ROI"])).toEqual([]);
});

test("special characters in a phrase are taken literally, and a blank phrase matches nothing", () => {
  expect(bannedIn("costs $5 (flat)", ["$5 (flat)"])).toEqual(["$5 (flat)"]);
  expect(bannedIn("costs 5 flat", ["$5 (flat)"])).toEqual([]);
  expect(bannedIn("anything", ["  "])).toEqual([]);
});

test("a description in new words says the same thing, and a different one doesn't", () => {
  const first = "Audits of the books of small charities.";
  for (const again of ["Audits of the books (financial audits) for small charities.", "Audits of the books for small charities, sold as a yearly audit."]) expect(saysTheSame("what_you_sell", first, again)).toBe(true);
  expect(saysTheSame("what_you_sell", first, "Bookkeeping software for restaurants.")).toBe(false);
  expect(saysTheSame("who_buys", "Charities with 10 staff", "Charities with 50 staff")).toBe(false);
  expect(saysTheSame("tone", "!!!", "???")).toBe(false);
});

test("a price or a claim has to match, whatever its words share", () => {
  expect(saysTheSame("price", "$4,500 per year", "$4,500 per month")).toBe(false);
  expect(saysTheSame("claim", "Trusted by small charities", "Trusted by many small charities")).toBe(false);
  expect(saysTheSame("price", " $9 ", "$9")).toBe(true);
});

test("a Voice example is refused when empty, too long, or holding an email address or a phone number", () => {
  expect(exampleText("  We write like we talk.\nShort lines.  ")).toEqual({ ok: true, text: "We write like we talk.\nShort lines." });
  expect(exampleText("   ")).toEqual({ ok: false, reason: "voice_empty" });
  expect(exampleText("x".repeat(MAX_EXAMPLE_CHARS + 1))).toEqual({ ok: false, reason: "voice_too_long" });
  expect(exampleText("Write back to kim@acme.test any time")).toEqual({ ok: false, reason: "voice_has_email" });
  expect(exampleText("Call us on +44 (0)20 7946 0018")).toEqual({ ok: false, reason: "voice_has_phone" });
  // Years and prices are not phone numbers.
  expect(exampleText("Since 2019, from $1,200 a month").ok).toBe(true);
});

test("a word swap needs two different words of at most 40 characters", () => {
  expect(swapWords("  users ", "customers")).toEqual({ ok: true, avoid: "users", prefer: "customers" });
  expect(swapWords("users", " ")).toEqual({ ok: false, reason: "voice_empty" });
  expect(swapWords("Users", "users")).toEqual({ ok: false, reason: "voice_swap_same" });
  expect(swapWords("u".repeat(MAX_SWAP_CHARS + 1), "x")).toEqual({ ok: false, reason: "voice_too_long" });
});

test("Voice holds 5 examples and 30 swaps, and an avoided word only once in any case", () => {
  const examples = Array.from({ length: MAX_EXAMPLES }, (_, n) => ({ kind: "example" as const, text: `e${n}` }));
  expect(fits(examples.slice(1), { kind: "example", text: "new" })).toBeNull();
  expect(fits(examples, { kind: "example", text: "new" })).toBe("voice_examples_full");
  const swaps = Array.from({ length: MAX_SWAPS }, (_, n) => ({ kind: "swap" as const, text: `w${n}` }));
  expect(fits([...examples, ...swaps.slice(1)], { kind: "swap", text: "new" })).toBeNull();
  expect(fits(swaps, { kind: "swap", text: "new" })).toBe("voice_swaps_full");
  expect(fits([{ kind: "swap", text: "Users" }], { kind: "swap", text: "users" })).toBe("voice_swap_exists");
});
