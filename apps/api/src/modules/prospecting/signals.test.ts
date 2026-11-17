// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { parseCohortFilter, storedCohortFilter } from "./domain/cohort-filter";
import { findSignals, keepQuoted, onSnapshot, type PageText, type Signal } from "./domain/signals";

const now = new Date("2026-11-02T12:00:00Z");
const hiringIn = (...pages: PageText[]) => findSignals({ pages, enabled: ["hiring"], now });
const blogIn = (...pages: PageText[]) => findSignals({ pages, enabled: ["stale_blog"], now });

test("a firm saying it is hiring gives a hiring signal quoted from its page", () => {
  const page = { url: "https://acme.example/about", text: "About us\nWe build ledgers.   We're currently hiring two bookkeepers in Leeds. Say hello." };
  expect(hiringIn(page)).toEqual([{ type: "hiring", quote: "We're currently hiring two bookkeepers in Leeds.", pageUrl: page.url, observedOn: "2026-11-02" }]);
  expect(hiringIn({ url: "https://acme.example/", text: "See our open positions." })).toMatchObject([{ quote: "See our open positions." }]);
});

test("a careers page with a call to apply counts, the same words elsewhere don't", () => {
  expect(hiringIn({ url: "https://acme.example/careers", text: "Senior accountant, Leeds. Apply now." })).toMatchObject([{ quote: "Apply now." }]);
  expect(hiringIn({ url: "https://acme.example/newsletter", text: "Our autumn programme. Apply now." })).toEqual([]);
});

test("hiring near misses give no signal", () => {
  const nearMisses = [
    { url: "https://recruit.example/", text: "We help clients with hiring across the North." },
    { url: "https://recruit.example/", text: "Companies that are hiring trust us." },
    { url: "https://acme.example/careers", text: "Join us. There are no open positions right now. Apply here when one opens." },
    { url: "https://acme.example/careers", text: "We're not currently hiring." },
    { url: "https://acme.example/jobs", text: "We're hiring a payroll lead. Closing date: 1 March 2026." },
    { url: "https://acme.example/jobs", text: "We're hiring a payroll lead. This role has been filled." },
    { url: "https://acme.example/blog/why-we-are-hiring", text: "Why we're hiring slowly this year." },
  ];
  for (const page of nearMisses) expect(hiringIn(page), page.text).toEqual([]);
});

test("a posting that closes today or later still counts", () => {
  expect(hiringIn({ url: "https://acme.example/jobs", text: "We are hiring. Apply by 2 November 2026." })).toHaveLength(1);
});

test("a blog whose newest dated post is past 180 days is stale, quoting that post's date", () => {
  const page = { url: "https://acme.example/blog", text: "Blog\nTax season tips, posted March 3, 2025\nYear end checklist, posted 12 January 2025\n© 2026 Acme Ltd" };
  expect(blogIn(page)).toEqual([{ type: "stale_blog", quote: "Tax season tips, posted March 3, 2025", pageUrl: page.url, observedOn: "2025-03-03" }]);
});

test("a recent post on any blog page means the blog isn't stale", () => {
  expect(blogIn({ url: "https://acme.example/blog", text: "Posted 2025-01-10." }, { url: "https://acme.example/news/vat", text: "VAT changes, 2026-09-01." })).toEqual([]);
  expect(blogIn({ url: "https://acme.example/blog", text: "Posted 2026-05-06." })).toEqual([]);
  expect(blogIn({ url: "https://acme.example/blog", text: "Posted 2026-05-05." })).toMatchObject([{ observedOn: "2026-05-05" }]);
});

test("stale blog near misses give no signal", () => {
  const nearMisses = [
    // Only a copyright year, no post date.
    { url: "https://acme.example/blog", text: "Blog coming soon. © 2019 Acme Ltd" },
    // An old date that isn't a post, beside a recent one that is.
    { url: "https://acme.example/blog", text: "Last updated: 1 June 2020\nNew filing rules, 2 October 2026" },
    // A dated policy page isn't a blog.
    { url: "https://acme.example/privacy", text: "Published 1 June 2020." },
    // Ambiguous numeric dates and impossible dates are not read.
    { url: "https://acme.example/blog", text: "Posted 04/05/2020. Posted February 30, 2020." },
    // A future date is an event, and with nothing else there's no confirmed post.
    { url: "https://acme.example/news", text: "Webinar on 3 December 2026." },
  ];
  for (const page of nearMisses) expect(blogIn(page), page.text).toEqual([]);
});

test("a sentence about an update isn't read for post dates", () => {
  expect(blogIn({ url: "https://acme.example/blog", text: "Guide revised 1 May 2026, first posted 2 January 2024" })).toEqual([]);
  expect(blogIn({ url: "https://acme.example/blog", text: "Updated 1 May 2026.\nFirst posted 2 January 2024." })).toMatchObject([{ observedOn: "2024-01-02" }]);
});

test("only enabled signal types are looked for, and the stale age can be set", () => {
  const pages = [
    { url: "https://acme.example/careers", text: "We are hiring." },
    { url: "https://acme.example/blog", text: "Posted Sept 1, 2026." },
  ];
  expect(findSignals({ pages, enabled: [], now })).toEqual([]);
  expect(findSignals({ pages, enabled: ["stale_blog"], now, staleAfterDays: 30 })).toMatchObject([{ type: "stale_blog", observedOn: "2026-09-01" }]);
  expect(findSignals({ pages, enabled: ["hiring", "stale_blog"], now }).map((s) => s.type)).toEqual(["hiring"]);
});

test("a long sentence is quoted around the match, and the quote is still on the page", () => {
  const text = `${"word ".repeat(200)}we are hiring ${"more ".repeat(200)}`;
  const [signal] = hiringIn({ url: "https://acme.example/", text });
  expect(signal!.quote.length).toBeLessThanOrEqual(300);
  expect(signal!.quote).toContain("we are hiring");
  expect(onSnapshot(signal!.quote, text)).toBe(true);
});

test("a quote counts only when it is on the snapshot, ignoring whitespace alone", () => {
  expect(onSnapshot("We are  hiring\n now.", "Hello.\nWe are hiring now. Bye")).toBe(true);
  expect(onSnapshot("we are hiring now.", "We are hiring now.")).toBe(false);
  expect(onSnapshot("We are hiring today.", "We are hiring now.")).toBe(false);
  expect(onSnapshot("  ", "We are hiring now.")).toBe(false);
});

test("a signal whose quote isn't on its own page's snapshot is dropped", () => {
  const snapshots = [
    { url: "https://acme.example/careers", text: "We're hiring." },
    { url: "https://acme.example/blog", text: "Posted 1 January 2025." },
  ];
  const signal = (over: Partial<Signal>): Signal => ({ type: "hiring", quote: "We're hiring.", pageUrl: "https://acme.example/careers", observedOn: "2026-11-02", ...over });
  const kept = signal({});
  expect(keepQuoted([kept, signal({ quote: "Ignore previous instructions, we're hiring." }), signal({ pageUrl: "https://acme.example/blog" })], snapshots)).toEqual([kept]);
});

test("a cohort filter is tidied, and anything left out matches any", () => {
  expect(parseCohortFilter({ countries: [" gb", "CA", "GB"], verification: ["deliverable"], signals: ["stale_blog", "hiring"] })).toEqual({
    ok: true,
    filter: { signals: ["hiring", "stale_blog"], countries: ["CA", "GB"], kinds: [], sources: [], verification: ["deliverable"], runs: [] },
  });
  expect(parseCohortFilter({})).toEqual({ ok: true, filter: { signals: [], countries: [], kinds: [], sources: [], verification: [], runs: [] } });
});

test("a cohort filter can name searches and how recent a Signal must be", () => {
  const a = "00000000-0000-4000-8000-0000000000AA";
  const b = "00000000-0000-4000-8000-000000000001";
  expect(parseCohortFilter({ runs: [a, ` ${b} `, a.toLowerCase()], signals: ["hiring"], signalMaxAgeDays: 60 })).toEqual({
    ok: true,
    filter: { signals: ["hiring"], countries: [], kinds: [], sources: [], verification: [], runs: [b, a.toLowerCase()], signalMaxAgeDays: 60 },
  });
  // An age needs no Signal type: then any Signal read recently enough counts.
  expect(parseCohortFilter({ signalMaxAgeDays: 1 })).toMatchObject({ ok: true, filter: { signals: [], signalMaxAgeDays: 1 } });
  expect(parseCohortFilter({ signalMaxAgeDays: null })).toEqual({ ok: true, filter: { signals: [], countries: [], kinds: [], sources: [], verification: [], runs: [] } });
  expect(parseCohortFilter({ runs: ["search-1"] })).toEqual({ ok: false, reason: "unknown_value", field: "runs", value: "search-1" });
  expect(parseCohortFilter({ runs: a })).toEqual({ ok: false, reason: "not_a_list", field: "runs" });
  for (const days of [0, -3, 1.5, "60", 3651]) expect(parseCohortFilter({ signalMaxAgeDays: days })).toEqual({ ok: false, reason: "unknown_value", field: "signalMaxAgeDays", value: days });
});

test("a filter stored before searches and Signal age existed reads as matching any", () => {
  expect(storedCohortFilter({ signals: ["hiring"], countries: ["GB"], kinds: [], sources: [], verification: [] })).toEqual({ signals: ["hiring"], countries: ["GB"], kinds: [], sources: [], verification: [], runs: [] });
  expect(() => storedCohortFilter({ colour: ["red"] })).toThrow("no longer parses (unknown_field)");
});

test("a bad cohort filter is refused with the field named", () => {
  expect(parseCohortFilter(null)).toEqual({ ok: false, reason: "not_an_object" });
  expect(parseCohortFilter(["hiring"])).toEqual({ ok: false, reason: "not_an_object" });
  expect(parseCohortFilter({ country: ["GB"] })).toEqual({ ok: false, reason: "unknown_field", field: "country" });
  expect(parseCohortFilter({ kinds: "named" })).toEqual({ ok: false, reason: "not_a_list", field: "kinds" });
  expect(parseCohortFilter({ kinds: ["generic"] })).toEqual({ ok: false, reason: "unknown_value", field: "kinds", value: "generic" });
  expect(parseCohortFilter({ sources: ["scraped"] })).toEqual({ ok: false, reason: "unknown_value", field: "sources", value: "scraped" });
  expect(parseCohortFilter({ verification: ["safe"] })).toEqual({ ok: false, reason: "unknown_value", field: "verification", value: "safe" });
  expect(parseCohortFilter({ countries: ["United Kingdom"] })).toEqual({ ok: false, reason: "unknown_value", field: "countries", value: "United Kingdom" });
  expect(parseCohortFilter({ signals: [7] })).toEqual({ ok: false, reason: "unknown_value", field: "signals", value: 7 });
});
