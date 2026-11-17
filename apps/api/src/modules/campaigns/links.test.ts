// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { foreignLinks, hostOf, linksIn } from "./domain/links";

const FACTS = "Website: https://acme.com. Write to hello@acme.com.";

test.each([
  // The three the review got past.
  ["Order at evil.shop today", ["evil.shop"]],
  ["See bit.ly/abc", ["bit.ly/abc"]],
  ["Visit acme.co", ["acme.co"]],
  // Near misses of the vouched host.
  ["Log in at mail.acme.com", ["mail.acme.com"]],
  ["Go to acme.com.evil.io", ["acme.com.evil.io"]],
  ["Open https://acme.com@evil.io/x", ["https://acme.com@evil.io/x"]],
  ["Open https://user@evil.io", ["https://user@evil.io"]],
  ["Visit аcme.com", ["аcme.com"]],
  ["Visit evil．shop", ["evil.shop"]],
  ["Mail me at kim@evil.io", ["kim@evil.io"]],
])("%s is foreign", (text, expected) => {
  expect(foreignLinks(text, FACTS)).toEqual(expected);
});

test.each([
  "See https://acme.com/pricing.",
  "See www.acme.com",
  "Write to hello@acme.com",
  "See ACME.COM",
  "See acme．com",
])("%s is vouched for by the Facts", (text) => {
  expect(foreignLinks(text, FACTS)).toEqual([]);
});

test.each(["Attached is report.pdf", "Version v2.1 is out", "Bring snacks, e.g. fruit", "That is, i.e. later", "Costs $4,500.00 a year", "Built on Node.js"])("%s holds no address", (text) => {
  expect(linksIn(text)).toEqual([]);
});

test("a URL Direx put in passes, with or without its utm_ tags, and nothing else on its host does", () => {
  const own = ["https://launch.example/page?ref=a"];
  expect(foreignLinks("See https://launch.example/page?ref=a", "", own)).toEqual([]);
  expect(foreignLinks("See https://launch.example/page?ref=a&utm_source=direx&utm_content=first", "", own)).toEqual([]);
  expect(foreignLinks("See https://launch.example/other", "", own)).toEqual(["https://launch.example/other"]);
  expect(foreignLinks("See https://launch.example/page?ref=b", "", own)).toEqual(["https://launch.example/page?ref=b"]);
  expect(foreignLinks("See launch.example/page", "", own)).toEqual(["launch.example/page"]);
});

test("nothing vouches for an address when no Fact holds one", () => {
  expect(foreignLinks("See https://acme.com", "There are no Facts to cite.")).toEqual(["https://acme.com"]);
});

test("a host is read as plain ASCII, without www or a trailing dot, or not at all", () => {
  expect(hostOf("https://WWW.Acme.com./x")).toBe("acme.com");
  expect(hostOf("hello@acme.com")).toBe("acme.com");
  expect(hostOf("аcme.com")).toBeNull();
  expect(hostOf("https://")).toBeNull();
});
