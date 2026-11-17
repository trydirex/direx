// SPDX-License-Identifier: AGPL-3.0-only
// Importing a list: its columns are read, guessed and matched to Direx's, and the list is rewritten
// as the CSV the import already takes.
import { expect, test } from "vitest";
import { countryCode, guessMapping, mapCsv, readCsv } from "./People";

test("a list's columns are guessed from their names; a column with no match is left out", () => {
  expect(guessMapping(["E-mail Address", "Name", "Organisation", "Domain", "Country", "Notes"])).toEqual({ email: 0, first_name: 1, company: 2, website: 3, country: 4 });
  expect(guessMapping(["Full name", "Phone"])).toEqual({ email: -1, first_name: -1, company: -1, website: -1, country: -1 });
});

test("the list is rewritten under Direx's names, country names become codes, and kept columns pass through", () => {
  const rows = readCsv('Mail,Who,Land,basis,Notes\nkim@acme.test,"Kim, Jr",United Kingdom,consent,x\nlee@acme.test,Lee,de,implied,y\n')!;
  const map = { email: 0, first_name: 1, company: -1, website: -1, country: 2 };
  expect(mapCsv(rows, map)).toBe('email,first_name,country,basis\nkim@acme.test,"Kim, Jr",GB,consent\nlee@acme.test,Lee,DE,implied');
  // One reason for the whole list replaces the file's own basis column.
  expect(mapCsv(rows, map, { basis: "legitimate_interest", evidence: 'From "leads.csv"' })).toBe(
    'email,first_name,country,basis,evidence\nkim@acme.test,"Kim, Jr",GB,legitimate_interest,"From ""leads.csv"""\nlee@acme.test,Lee,DE,legitimate_interest,"From ""leads.csv"""',
  );
});

test("a row with the wrong number of columns stays short, so the import reports it; a stray quote can't be read", () => {
  expect(mapCsv(readCsv("email,name\na@acme.test\nb@acme.test,Bo")!, { email: 0, first_name: 1, company: -1, website: -1, country: -1 })).toBe("email,first_name\n\nb@acme.test,Bo");
  expect(readCsv('email\na"b@acme.test')).toBeNull();
  expect(countryCode("Narnia")).toBe("Narnia");
});
