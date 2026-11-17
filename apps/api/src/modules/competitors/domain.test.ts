// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { checkFields, hasPrice, MAX_NAME_CHARS, MAX_PRICES_SHOWN, MAX_URL_CHARS, pricesIn, type CompetitorFields } from "./domain/competitor";

const row = (over: Partial<CompetitorFields> = {}): CompetitorFields => ({ name: "Double", pricingUrl: "https://doublehq.com/pricing-plans/", changelogUrl: null, landingUrl: null, ...over });

test("a name with one URL is enough, on any host", () => {
  expect(checkFields(row())).toBeNull();
  expect(checkFields(row({ pricingUrl: null, changelogUrl: "https://roadmap.xenett.com/announcements" }))).toBeNull();
});

test.each([
  ["", "name_missing"],
  ["   ", "name_missing"],
  ["x".repeat(MAX_NAME_CHARS + 1), "name_length"],
])("a name of %#", (name, problem) => {
  expect(checkFields(row({ name }))).toBe(problem);
});

test("a name at the limit, padded, is fine", () => {
  expect(checkFields(row({ name: ` ${"x".repeat(MAX_NAME_CHARS)} ` }))).toBeNull();
});

test("at least one URL", () => {
  expect(checkFields(row({ pricingUrl: null }))).toBe("no_url");
});

test("a comparison page is optional, doesn't count as a URL to read, and must be a web address", () => {
  expect(checkFields(row({ comparisonUrl: "https://us.example/vs-double" }))).toBeNull();
  expect(checkFields(row({ pricingUrl: null, comparisonUrl: "https://us.example/vs-double" }))).toBe("no_url");
  expect(checkFields(row({ comparisonUrl: "javascript:alert(1)" }))).toBe("bad_url");
});

test.each(["ftp://doublehq.com/pricing", "doublehq.com/pricing", "javascript:alert(1)", `https://a.com/${"x".repeat(MAX_URL_CHARS)}`])("not a web address: %s", (url) => {
  expect(checkFields(row({ landingUrl: url }))).toBe("bad_url");
});

test.each([
  ["$15", true],
  ["$ 15 per client", true],
  ["15 USD", true],
  ["€9.99", true],
  ["1,200.50 eur a year", true],
  ["£10", true],
  ["Contact sales", false],
  ["50+ AI checks", false],
  ["Up to 10 clients", false],
  ["", false],
])("hasPrice(%j) is %s", (text, found) => {
  expect(hasPrice(text)).toBe(found);
});

test("pricesIn lists each price once, in page order, so add-on prices alone are visible as such", () => {
  // Double's pricing page as the reader sees it (r64): the plan cards are drawn by a script, the add-ons are text.
  const double = "Autoclose Add-on $500 per month. The Tax Suite Included with $200 per month annual commitment. Emails $10 per connected team email. Autoclose $500 per month.";
  expect(pricesIn(double)).toEqual(["$500", "$200", "$10"]);
  expect(pricesIn("Core 1,200.50 EUR, Plus € 9.99, then 15 usd.")).toEqual(["1,200.50 EUR", "€ 9.99", "15 usd"]);
  expect(pricesIn("Contact sales")).toEqual([]);
  expect(pricesIn(Array.from({ length: 10 }, (_, n) => `$${n + 1}`).join(" "))).toHaveLength(MAX_PRICES_SHOWN);
});
