// SPDX-License-Identifier: AGPL-3.0-only
// A country comes only from a postal address, each case paired with a near miss that names a country
// without giving an address.
import { expect, test } from "vitest";
import { countryFrom } from "./domain/country";

test.each([
  // A province and its postal code are enough, so the quote ends there.
  ["12 King Street West\nToronto, ON M5H 1A1\nCanada", "CA", "Toronto, ON M5H 1A1"],
  ["Home\nContact\n1 Main St, Suite 400\nAustin, TX 78701", "US", "Austin, TX 78701"],
  ["Hauptstraße 5\n10115 Berlin\nGermany", "DE", "Hauptstraße 5\n10115 Berlin\nGermany"],
  ["Keizersgracht 123, 1015 CJ Amsterdam, The Netherlands", "NL", "Keizersgracht 123, 1015 CJ Amsterdam, The Netherlands"],
  ["1 Poultry\nLondon EC2R 8EJ\nUK", "GB", "London EC2R 8EJ\nUK"],
  ["Unit 4, Harbour Road\nDublin 2, Ireland.", "IE", "Unit 4, Harbour Road\nDublin 2, Ireland."],
  ["500 Bay Street\nToronto, Ontario M5V 2T6\nBosnia and Herzegovina", "BA", "500 Bay Street\nToronto, Ontario M5V 2T6\nBosnia and Herzegovina"],
  ["Via Roma 5\n00184 Roma\nItaly", "IT", "Via Roma 5\n00184 Roma\nItaly"],
])("%j is in %s", (text, code, quote) => {
  expect(countryFrom([text])).toEqual({ code, quote });
});

test.each([
  "Proudly serving clients across Canada since 1998.",
  "We work with founders in Germany",
  "Founded in 2001 in Canada",
  "Offices: Toronto, Canada",
  "Contact us",
  "12 Peachtree Street\nAtlanta, Georgia",
  "100 Broad Street\nNewark, New Jersey",
  "Our 12 Main Street office has moved, and we now work remotely with clients all over the world, from small towns to big cities in the United Kingdom",
  "Call ON 12345 now",
  "",
])("%j gives no country", (text) => {
  expect(countryFrom([text])).toBeNull();
});

test("the first page with an address wins, and a later page isn't needed", () => {
  expect(countryFrom(["Welcome", "1 Main St\nAustin, TX 78701", "12 King Street West\nToronto, ON M5H 1A1\nCanada"])?.code).toBe("US");
});
