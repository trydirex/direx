// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { keptPeople, MAX_NAMES_CHARS, namesText, type NamedPerson } from "./domain/people";
import { NAMES_CASES, scoreNamesRun } from "./evals";

const page = (text: string) => [{ url: "https://acme.test/team", text }];
const p = (first: string, last = "", role: string | null = null): NamedPerson => ({ first, last, role });

test("a name is kept only when the page holds it, ignoring case, spacing and punctuation", () => {
  const pages = page("OUR TEAM:\nJane   Doe — Managing Partner.\nMary-Ann O'Neil, Tax\nJosé Núñez");
  expect(keptPeople([p("jane", "DOE", " Managing Partner ")], pages)).toEqual([p("jane", "DOE", "Managing Partner")]);
  expect(keptPeople([p("Mary-Ann", "O'Neil")], pages)).toHaveLength(1);
  expect(keptPeople([p("Mary Ann", "ONeil")], pages)).toHaveLength(0);
  expect(keptPeople([p("José", "Núñez")], pages)).toHaveLength(1);
});

test("near misses aren't the same name", () => {
  const pages = page("Janet Doer, partner. Doe, Jane wrote this. Jan Doe-Smith.");
  for (const miss of [p("Jane", "Doe"), p("Jan", "Doe"), p("Janet", "Doe"), p("Jana"), p("Doers")]) expect(keptPeople([miss], pages)).toEqual([]);
  expect(keptPeople([p("Janet", "Doer")], pages)).toHaveLength(1);
});

test("a first name alone counts only when no last name was reported", () => {
  const pages = page("Say hello to Priya, our office manager.");
  expect(keptPeople([p("Priya", "", "Office Manager")], pages)).toEqual([p("Priya", "", "Office Manager")]);
  expect(keptPeople([p("Priya", "Shah")], pages)).toEqual([]);
});

test("anything not shaped like a name is dropped, even when the page holds it", () => {
  const pages = page("Contact info@acme.test or call 555 0100. Team 2 lead: Bob Smith. Click here.");
  for (const bad of [p("info@acme.test"), p("555", "0100"), p("Bob", "Smith 2"), p(""), p("   ", "Smith"), p("Click here to see our wonderful team today")]) {
    expect(keptPeople([bad], pages)).toEqual([]);
  }
});

test("people are kept once each, in the order given, and at most two", () => {
  const pages = page("Jane Doe, Raj Patel and Lee Wong.");
  expect(keptPeople([p("Jane", "Doe"), p("jane", "doe"), p("Raj", "Patel"), p("Lee", "Wong")], pages).map((x) => x.first)).toEqual(["Jane", "Raj"]);
  expect(keptPeople([p("Ghost", "Writer"), p("Lee", "Wong")], [...page("nobody"), ...page("Lee Wong")]).map((x) => x.first)).toEqual(["Lee"]);
});

test("the names run sees the domain and each page under its address, cut to 8,000 characters", () => {
  const text = namesText("acme.test", [
    { url: "https://acme.test/", text: "Home" },
    { url: "https://acme.test/team", text: "x".repeat(10_000) },
  ]);
  expect(text.startsWith("Company website: acme.test\n\nPage https://acme.test/:\nHome\n\nPage https://acme.test/team:\nxxx")).toBe(true);
  expect(text).toHaveLength(MAX_NAMES_CHARS);
});

test("the real names eval fails a run that reports a client, drops a wanted name or hands nothing over", () => {
  const c = NAMES_CASES[0]!;
  expect(scoreNamesRun(c, [p("Jane", "Doe"), p("Raj", "Patel")])).toEqual([]);
  expect(scoreNamesRun(c, [p("Tom", "Client"), p("Jane", "Doe")])).toEqual(["missed Raj Patel", "reported Tom Client"]);
  expect(scoreNamesRun(c, null)).toEqual(["no output"]);
  // Every case's wanted people are on its pages, so a perfect reader can pass it.
  for (const k of NAMES_CASES) expect(scoreNamesRun(k, k.want.map((w) => p(w.split(" ")[0]!, w.split(" ")[1] ?? "")))).toEqual([]);
});
