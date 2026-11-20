// SPDX-License-Identifier: AGPL-3.0-only
// The page rules against ten real competitors, captured 2026-11-20 as Direx-page-reader and trimmed
// to the links that matter plus a few others. Botkeeper and Finlens have no changelog page.
import { expect, test } from "vitest";
import { changelogOf, findPages, keep, linksIn, roadmapOf, sameSite, sitemapsIn, type Candidate, type FoundPages } from "./domain/find-pages";
import sites from "./fixtures/find-pages-sites.json";

type Site = { given: string; finalUrl: string; homepage: string[][]; sitemap: string[]; roadmap?: { url: string; links: string[][] } };
const links = (pairs: string[][]) => pairs.map(([url, text]) => ({ url: url!, text: text! }));

/** What the reader does: the homepage and sitemap, then the roadmap page when no changelog was found. */
function run(name: keyof typeof sites): FoundPages {
  const s = sites[name] as Site;
  const cands = [...keep(s.given, links(s.homepage), "homepage"), ...keep(s.given, s.sitemap.map((url) => ({ url, text: "" })), "sitemap")];
  const r = findPages(s.given, s.finalUrl, cands);
  if (r.ok && !r.changelog && s.roadmap) {
    expect(roadmapOf(cands)).toBe(s.roadmap.url);
    return { ...r, changelog: changelogOf(keep(s.given, links(s.roadmap.links), "roadmap")) };
  }
  return r;
}

test.each([
  ["doublehq.com", "https://doublehq.com/pricing-plans/", "https://doublehq.canny.io/changelog"],
  ["xenett.com", "https://www.xenett.com/pricing", "https://roadmap.xenett.com/announcements"],
  ["botkeeper.com", "https://www.botkeeper.com/pricing", null],
  ["booke.ai", "https://booke.ai/pricing", "https://booke.ai/changes-logging"],
  ["finlens.app", "https://www.finlens.app/founders-pricing", null],
  ["dext.com", "https://dext.com/partner/pricing", "https://dext.com/ca/release-logs"],
  ["digits.com", "https://digits.com/pricing/", "https://help.digits.com/changelog"],
  ["puzzle.io", "https://puzzle.io/pricing", "https://puzzle.io/category/product-updates"],
  ["zeni.ai", "https://www.zeni.ai/pricing", "https://www.zeni.ai/product-updates"],
] as const)("%s: pricing and changelog", (name, pricing, changelog) => {
  const r = run(name);
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  expect(r.pricing?.url).toBe(pricing);
  expect(r.changelog?.url ?? null).toBe(changelog);
});

test("each page says where it was found", () => {
  expect(run("doublehq.com")).toMatchObject({ pricing: { via: "homepage", text: "Pricing" }, changelog: { via: "homepage", text: "Product Releases" } });
  expect(run("puzzle.io")).toMatchObject({ changelog: { via: "sitemap" } });
  expect(run("xenett.com")).toMatchObject({ changelog: { via: "roadmap" } });
});

test("an address that lands on another company's site proposes nothing", () => {
  expect(run("keeper.app")).toEqual({ ok: false, reason: "other_site", host: "doublehq.com" });
});

test("other pricing pages the homepage links are also found, not blog posts or regional copies", () => {
  expect(run("finlens.app")).toMatchObject({ alsoPricing: ["https://www.finlens.app/accountants-pricing"] });
  expect(run("dext.com")).toMatchObject({ alsoPricing: ["https://dext.com/business/pricing"] });
  expect(run("booke.ai")).toMatchObject({ alsoPricing: [] });
  expect(run("zeni.ai")).toMatchObject({ alsoPricing: [] });
});

const cand = (url: string, text = "", via: Candidate["via"] = "homepage"): Candidate => ({ url, text, via });

test("a roadmap is never the changelog, and a page that names itself one beats a generic updates page", () => {
  expect(changelogOf([cand("https://x.com/roadmap", "Changelog")])).toBeNull();
  expect(changelogOf([cand("https://x.com/updates"), cand("https://x.com/product/changelog")])?.url).toBe("https://x.com/product/changelog");
  expect(changelogOf([cand("https://x.com/a/b/changelog")])).toBeNull();
  expect(changelogOf([cand("https://x.com/news", "What's new")])?.url).toBe("https://x.com/news");
  expect(changelogOf([cand("https://acme.canny.io/feature-requests")])).toBeNull();
});

test("no roadmap page means none to read, and only one linked from the homepage counts", () => {
  expect(roadmapOf([cand("https://x.com/pricing")])).toBeNull();
  expect(roadmapOf([cand("https://x.com/roadmap", "", "sitemap")])).toBeNull();
});

test("only the site's own addresses and the hosted changelog services are kept", () => {
  const found = ["https://roadmap.acme.com/x", "https://acme.headwayapp.co/", "https://twitter.com/acme", "https://notacme.com/pricing"].map((url) => ({ url, text: "" }));
  expect(keep("https://www.acme.com", found, "homepage").map((c) => c.url)).toEqual(["https://roadmap.acme.com/x", "https://acme.headwayapp.co/"]);
  expect(keep("https://www.acme.com", found, "sitemap").map((c) => c.url)).toEqual(["https://roadmap.acme.com/x"]);
  expect(sameSite(new URL("https://acme.com"), new URL("https://www.acme.com/a"))).toBe(true);
});

test("links come with their text, resolved, without query or fragment, each once", () => {
  const html = `<a href="/pricing?ref=nav#top" class="x"><span>Plans &amp;</span> Pricing</a>
    <a href='https://acme.com/pricing'></a><a href="mailto:hi@acme.com">Mail</a><a href="https://u:p@acme.com/x">x</a>
    <a href="javascript:void(0)">no</a><a href="http://[bad">bad</a>`;
  expect(linksIn(html, "https://acme.com/")).toEqual([{ url: "https://acme.com/pricing", text: "Plans & Pricing" }]);
});

test("robots.txt names its sitemaps", () => {
  expect(sitemapsIn("User-agent: *\nDisallow: /a\nSitemap: https://acme.com/s1.xml\n  sitemap:https://acme.com/s2.xml")).toEqual(["https://acme.com/s1.xml", "https://acme.com/s2.xml"]);
  expect(sitemapsIn("User-agent: *")).toEqual([]);
});

test("an explicit changelog label identifies a hosted newspage root", () => {
  expect(changelogOf([cand("https://acme.noticeable.news/", "Changelog")])?.url).toBe("https://acme.noticeable.news/");
  expect(changelogOf([cand("https://acme.noticeable.news/")])).toBeNull();
  expect(changelogOf([cand("https://acme.noticeable.news/roadmap", "Changelog")])).toBeNull();
});

test("unclosed anchors do not swallow a later labelled link", () => {
  const html = '<a href="/ignored">'.repeat(20_000) + '<a href="/changelog"><span>Change</span> log</a>';
  expect(linksIn(html, "https://acme.com/")).toEqual([{ url: "https://acme.com/changelog", text: "Change log" }]);
});
