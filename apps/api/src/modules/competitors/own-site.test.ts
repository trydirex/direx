// SPDX-License-Identifier: AGPL-3.0-only
// Competitor names from a Workspace's own sitemap. The Equility addresses are real (read 2026-11-20);
// over all 425 in that sitemap the rules name exactly Double, Karbon and Botkeeper.
import { expect, test } from "vitest";
import { nameKey, nameOf, namesFromSitemap, ownNames, siteFromLinks, siteKey } from "./domain/own-site";

const EQUILITY = "https://www.equilityhq.com/";
const equility = [
  "https://www.equilityhq.com/about",
  "https://www.equilityhq.com/pricing",
  "https://www.equilityhq.com/double-alternative",
  "https://www.equilityhq.com/botkeeper-alternative",
  "https://www.equilityhq.com/karbon-alternative",
  "https://www.equilityhq.com/blog/evaluating-outsourced-accounting-firms-vs-in-house-accounting",
  "https://www.equilityhq.com/blog/accounting-software-compatible-with-quickbooks-online",
  "https://www.equilityhq.com/blog/about-home-office-deduction",
];

test("a site's own names, with and without a trailing hq, app, io or ai", () => {
  expect(ownNames(EQUILITY)).toEqual(["equilityhq", "equility"]);
  expect(ownNames("https://booke.ai/")).toEqual(["booke"]);
  expect(ownNames("https://xenett.com/")).toEqual(["xenett"]);
  expect(ownNames("https://www.zeni.ai/")).toEqual(["zeni"]);
});

test("Equility's sitemap names Double, Botkeeper and Karbon, and the blog post names no one", () => {
  expect(namesFromSitemap(equility, ownNames(EQUILITY))).toEqual([
    { slug: "double", url: "https://www.equilityhq.com/double-alternative" },
    { slug: "karbon", url: "https://www.equilityhq.com/karbon-alternative" },
    { slug: "botkeeper", url: "https://www.equilityhq.com/botkeeper-alternative" },
  ]);
});

test.each([
  ["/alternatives-to-double", "double"],
  ["/double-alternatives", "double"],
  ["/double-comparison", "double"],
  ["/vs-double", "double"],
  ["/compare/double", "double"],
  ["/compare/equility-vs-double", "double"],
  ["/vs/double-vs-equility-hq", "double"],
  ["/vs/booke-ai", "booke-ai"],
  ["/equility-vs-double", "double"],
  ["/double-vs-equility", "double"],
  ["/en/equilityhq-vs-xenett/", "xenett"],
])("%s names %s", (path, slug) => {
  expect(namesFromSitemap([`https://www.equilityhq.com${path}`], ownNames(EQUILITY))).toEqual([{ slug, url: `https://www.equilityhq.com${path}` }]);
});

test.each([
  "/double-vs-xenett",
  "/compare/double-vs-xenett",
  "/vs/double-vs-xenett",
  "/equility-vs-double-vs-xenett",
  "/equility-alternative",
  "/equility-hq-alternative",
  "/a-alternative",
  "/one-two-three-four-alternative",
  "/compare",
  "/",
])("%s names no competitor", (path) => {
  expect(namesFromSitemap([`https://www.equilityhq.com${path}`], ownNames(EQUILITY))).toEqual([]);
});

test("one page per competitor, the shortest address", () => {
  const locs = ["https://www.equilityhq.com/en-us/double-alternative", "https://www.equilityhq.com/double-alternative"];
  expect(namesFromSitemap(locs, ownNames(EQUILITY))).toEqual([{ slug: "double", url: "https://www.equilityhq.com/double-alternative" }]);
  const shorter = "https://www.equilityhq.com/booke-ai-alternative";
  const longer = "https://www.equilityhq.com/en/bookeai-alternative";
  expect(namesFromSitemap([longer, shorter], ownNames(EQUILITY))).toEqual([{ slug: "booke-ai", url: shorter }]);
});

test("names read as words, and every way of writing one is the same key", () => {
  expect(nameOf("booke-ai")).toBe("Booke Ai");
  expect(nameOf("double")).toBe("Double");
  expect(new Set([nameKey("Booke AI"), nameKey("booke-ai"), nameKey("BookeAI")]).size).toBe(1);
  expect(siteKey("https://www.Botkeeper.com/pricing")).toBe("botkeeper.com");
});

test("a site comes only from a link on our page whose name holds the competitor's", () => {
  const botkeeperPage = [
    "https://www.equilityhq.com/pricing",
    "https://www.accountingtoday.com/news/botkeeper-infinite-acquired-by-xendoo-platform-will-live-again",
    "https://www.botkeeper.com/pricing",
  ];
  expect(siteFromLinks("botkeeper", botkeeperPage, EQUILITY)).toBe("https://www.botkeeper.com/");
  expect(siteFromLinks("double", botkeeperPage, EQUILITY)).toBeNull();
  expect(siteFromLinks("booke-ai", ["https://booke.ai/pricing"], EQUILITY)).toBeNull();
  expect(siteFromLinks("booke-ai", ["https://bookeai.com/"], EQUILITY)).toBe("https://bookeai.com/");
});
