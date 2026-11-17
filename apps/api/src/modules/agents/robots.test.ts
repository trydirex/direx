// SPDX-License-Identifier: AGPL-3.0-only
// The files here are shaped like ones found on real small-company sites.
import { expect, test } from "vitest";
import { createFetchHtml, PAGE_READER_AGENT } from "./index";
import { allowed, robotsFrom } from "./domain/robots";

const ME = PAGE_READER_AGENT;
const file = (text: string) => robotsFrom({ ok: true, html: text, truncated: false });
const may = (text: string, path: string) => allowed(file(text), ME, path);

test("a file naming only other bots leaves Direx free to read", () => {
  const text = "User-agent: Googlebot\nDisallow: /\n\nUser-agent: AhrefsBot\nUser-agent: SemrushBot\nDisallow: /";
  expect(may(text, "/team")).toBe(true);
});

test("an empty Disallow and an Allow of everything both allow everything", () => {
  expect(may("User-agent: *\nDisallow:", "/about")).toBe(true);
  expect(may("User-agent: *\nAllow: /", "/about")).toBe(true);
  expect(may("", "/about")).toBe(true);
});

test("WordPress's usual file keeps out wp-admin but its ajax endpoint and the site stay open", () => {
  const text = "# WordPress\nUser-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n\nSitemap: https://site.test/wp-sitemap.xml\n";
  expect(may(text, "/wp-admin/")).toBe(false);
  expect(may(text, "/wp-admin/options.php")).toBe(false);
  expect(may(text, "/wp-admin/admin-ajax.php")).toBe(true);
  expect(may(text, "/about-us/")).toBe(true);
});

test("Crawl-delay and other unknown lines are ignored, and comments are stripped", () => {
  const text = "User-agent: *\nCrawl-delay: 10\nHost: site.test\nDisallow: /cart # checkout\nnonsense line";
  expect(may(text, "/cart")).toBe(false);
  expect(may(text, "/cart/x")).toBe(false);
  expect(may(text, "/contact")).toBe(true);
});

test("CRLF line ends and a byte order mark are read like plain lines", () => {
  const text = "﻿User-agent: *\r\nDisallow: /team\r\n\r\nUser-agent: Googlebot\r\nDisallow: /";
  expect(may(text, "/team")).toBe(false);
  expect(may(text, "/")).toBe(true);
});

test("a group naming Direx replaces the * group, whichever way it points", () => {
  expect(may("User-agent: *\nDisallow: /\n\nUser-agent: direx-page-reader\nAllow: /", "/team")).toBe(true);
  expect(may("User-agent: *\nAllow: /\n\nUser-agent: Direx-Page-Reader\nDisallow: /", "/team")).toBe(false);
  expect(may("User-agent: Bingbot\nUser-agent: Direx-page-reader\nDisallow: /x\n\nUser-agent: *\nDisallow: /", "/team")).toBe(true);
});

test("groups for the same name are merged", () => {
  const text = "User-agent: *\nDisallow: /a\n\nUser-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /b";
  expect(may(text, "/a")).toBe(false);
  expect(may(text, "/b")).toBe(false);
  expect(may(text, "/c")).toBe(true);
});

test("the longest match wins, and Allow wins a tie", () => {
  expect(may("User-agent: *\nDisallow: /p\nAllow: /p", "/page")).toBe(true);
  expect(may("User-agent: *\nAllow: /folder\nDisallow: /folder/private", "/folder/private/x")).toBe(false);
  expect(may("User-agent: *\nDisallow: /folder\nAllow: /folder/page", "/folder/page")).toBe(true);
});

test("* matches any run of characters and $ ends the path", () => {
  const text = "User-agent: *\nDisallow: /*.pdf$\nDisallow: /*?\nDisallow: /shop/*/basket";
  expect(may(text, "/files/a.pdf")).toBe(false);
  expect(may(text, "/files/a.pdf.html")).toBe(true);
  expect(may(text, "/team?ref=1")).toBe(false);
  expect(may(text, "/team")).toBe(true);
  expect(may(text, "/shop/x/y/basket/1")).toBe(false);
  expect(may(text, "/shop/basket")).toBe(true);
});

test("robots.txt itself may always be read", () => {
  expect(may("User-agent: *\nDisallow: /", "/robots.txt")).toBe(true);
});

test("a rule before any user-agent line is unclear, so nothing is read", () => {
  expect(may("Disallow: /private\nUser-agent: *\nAllow: /", "/about")).toBe(false);
});

test("a file cut short is not trusted", () => {
  expect(allowed(robotsFrom({ ok: true, html: "User-agent: *\nAllow: /", truncated: true }), ME, "/about")).toBe(false);
});

test("an app shell served at robots.txt counts as no file", () => {
  expect(may("<!doctype html><html><body><div id=root></div></body></html>", "/team")).toBe(true);
});

test.each([
  [401, false],
  [403, false],
  [404, true],
  [410, true],
  [429, false],
  [500, false],
  [503, false],
  [undefined, false],
])("robots.txt answering %s means the site may be read: %s", (status, expected) => {
  expect(allowed(robotsFrom({ ok: false, status }), ME, "/team")).toBe(expected);
});

test("a hostile pattern can't stall the matcher", () => {
  const text = `User-agent: *\nDisallow: /${"*a".repeat(2000)}b`;
  const started = performance.now();
  expect(may(text, `/${"a".repeat(5000)}`)).toBe(true);
  expect(performance.now() - started).toBeLessThan(2000);
});

test("a disallowed page isn't read, and robots.txt is fetched through the same checked reader", async () => {
  const connected: string[] = [];
  const fetchHtml = createFetchHtml({
    resolve: async () => [{ address: "93.184.216.34" }],
    request: async (url) => {
      connected.push(url.href);
      const body = url.pathname === "/robots.txt" ? "User-agent: *\nDisallow: /team" : "<p>page</p>";
      return new Response(body, { headers: { "content-type": url.pathname === "/robots.txt" ? "text/plain" : "text/html" } });
    },
  });
  const robots = robotsFrom(await fetchHtml("https://site.test/", "/robots.txt"));
  for (const path of ["/team", "/about"]) if (allowed(robots, ME, path)) await fetchHtml("https://site.test/", path);
  expect(connected).toEqual(["https://site.test/robots.txt", "https://site.test/about"]);
});
