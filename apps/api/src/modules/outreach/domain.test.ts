// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { eligibilityWarnings, notEligible } from "./domain/eligibility";

const now = new Date("2026-11-02T12:00:00Z");
const us = { country: "US", basis: "published_address" };

test.each([
  ["cold", null, "no basis recorded"],
  ["sales_follow_up", null, "no basis recorded"],
  ["consented_marketing", { country: "DE", basis: "legitimate_interest" }, "consented marketing needs a recorded consent"],
  ["consented_marketing", { country: "AT", basis: "implied" }, "consented marketing needs a recorded consent"],
  ["consented_marketing", { country: "IT", basis: "published_address" }, "consented marketing needs a recorded consent"],
  ["consented_marketing", us, "consented marketing needs a recorded consent"],
])("blocks %s with %j", (touchClass, record, why) => {
  expect(notEligible(touchClass, record, now)).toBe(why);
});

test.each([
  ["cold", us],
  ["cold", { country: "CA", basis: "implied" }],
  // The customer is the sender and answers for the law, so no country is refused here.
  ["cold", { country: "DE", basis: "consent" }],
  ["cold", { country: "AT", basis: "implied" }],
  ["cold", { country: "IT", basis: "legitimate_interest" }],
  // Near misses: these classes answer something the Person started.
  ["cold", { country: "DK", basis: "legitimate_interest" }],
  ["consented_marketing", { country: "US", basis: "consent" }],
  ["reply_in_thread", null],
  ["transactional", null],
  ["service", { country: "DE", basis: "implied" }],
])("allows %s with %j", (touchClass, record) => {
  expect(notEligible(touchClass, record, now)).toBeNull();
});

test.each(["cold", "sales_follow_up", "consented_marketing"])("a basis that expired holds %s", (touchClass) => {
  const record = { country: "US", basis: "consent", expiresAt: new Date("2026-11-01T00:00:00Z") };
  expect(notEligible(touchClass, record, now)).toBe("basis expired on 2026-11-01");
  expect(notEligible(touchClass, { ...record, expiresAt: now }, now)).toBe("basis expired on 2026-11-02");
});

test("a basis with a future or no expiry still counts", () => {
  expect(notEligible("cold", { ...us, expiresAt: new Date("2026-11-03T00:00:00Z") }, now)).toBeNull();
  expect(notEligible("cold", { ...us, expiresAt: null }, now)).toBeNull();
});

test.each(["reply_in_thread", "service", "transactional"])("%s ignores expiry", (touchClass) => {
  expect(notEligible(touchClass, { ...us, expiresAt: new Date("2020-01-01T00:00:00Z") }, now)).toBeNull();
});

const clean = { country: "US", basis: "published_address", entityType: "corporate", countryConfidence: "stated" };

test("a US corporate with a published address and a US sender gets no warning", () => {
  expect(eligibilityWarnings(clean, "US")).toEqual([]);
});

test.each([
  [{ country: "DE", basis: "legitimate_interest" }, "US", "consent_likely_needed"],
  [{ country: "GB", entityType: "sole_trader" }, "US", "entity_needs_consent"],
  [{ country: "GB", entityType: "partnership", basis: "implied" }, "US", "entity_needs_consent"],
  [{ country: "GB", entityType: "unknown" }, "US", "entity_unknown"],
  [{ country: "FI", entityType: "unknown" }, "US", "entity_unknown"],
  [{ country: "AR" }, "US", "not_researched"],
  [{ basis: "legitimate_interest" }, "CA", "sender_law"],
  [{ countryConfidence: "inferred" }, "US", "country_inferred"],
  [{}, null, "sender_country_missing"],
])("%j with sender %s warns %s", (change, sender, code) => {
  expect(eligibilityWarnings({ ...clean, ...change }, sender)).toEqual([code]);
});

test.each([
  // Consent answers what these warnings ask for.
  [{ country: "DE", basis: "consent" }, "US"],
  [{ country: "GB", entityType: "sole_trader", basis: "consent" }, "US"],
  [{ country: "GB", entityType: "corporate" }, "US"],
  [{ country: "CA", basis: "implied" }, "CA"],
])("%j with sender %s gets no warning", (change, sender) => {
  expect(eligibilityWarnings({ ...clean, ...change }, sender)).toEqual([]);
});
