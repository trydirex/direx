// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { aboutIn, findAbout, type Sitemap } from "./domain/about-page";

const H = "https://site.test/";

test.each([
  [["https://site.test/about"], "https://site.test/about"],
  [["https://site.test/about-us/"], "https://site.test/about-us/"],
  [["https://site.test/en/About"], "https://site.test/en/About"],
  [["https://site.test/en/about-us/", "https://site.test/about"], "https://site.test/about"],
  [["https://site.test/about-us-old", "https://site.test/about/team", "https://site.test/"], null],
  [[], null],
])("from %j the about page is %s", (locs, want) => {
  expect(aboutIn(locs)).toBe(want);
});

/** A site whose reads are counted. Pages that exist return their address. */
function site(maps: Record<string, Sitemap>, pages: string[]) {
  const reads: string[] = [];
  return {
    reads,
    read: {
      sitemap: async (url: string) => (reads.push(url), maps[url] ?? null),
      page: async (url: string) => (reads.push(url), pages.includes(url) ? url : null),
    },
  };
}

test("the sitemap's about page wins over the usual addresses", async () => {
  const s = site({ [`${H}sitemap.xml`]: { index: false, locs: [`${H}team`, `${H}en/about-us/`] } }, [`${H}en/about-us/`, `${H}about`]);
  expect(await findAbout(H, s.read)).toBe(`${H}en/about-us/`);
  expect(s.reads).toEqual([`${H}sitemap.xml`, `${H}en/about-us/`]);
});

test("a sitemap index reads children with 'page' in the name first, and at most 3", async () => {
  const maps: Record<string, Sitemap> = {
    [`${H}sitemap.xml`]: { index: true, locs: [`${H}post-sitemap.xml`, `${H}a.xml`, `${H}b.xml`, `${H}c.xml`, `${H}page-sitemap.xml`] },
    [`${H}page-sitemap.xml`]: { index: false, locs: [`${H}pricing`] },
    [`${H}c.xml`]: { index: false, locs: [`${H}about`] },
  };
  const s = site(maps, [`${H}about-us`]);
  expect(await findAbout(H, s.read)).toBe(`${H}about-us`);
  expect(s.reads).toEqual([`${H}sitemap.xml`, `${H}page-sitemap.xml`, `${H}post-sitemap.xml`, `${H}a.xml`, `${H}about`, `${H}about-us`]);
});

test("a child sitemap found in an index is used", async () => {
  const s = site({ [`${H}sitemap.xml`]: { index: true, locs: [`${H}page-sitemap.xml`] }, [`${H}page-sitemap.xml`]: { index: false, locs: [`${H}about`] } }, [`${H}about`]);
  expect(await findAbout(H, s.read)).toBe(`${H}about`);
});

test("no sitemap: /about, then /about-us, then nothing", async () => {
  expect(await findAbout(H, site({}, [`${H}about`, `${H}about-us`]).read)).toBe(`${H}about`);
  expect(await findAbout(H, site({}, [`${H}about-us`]).read)).toBe(`${H}about-us`);
  const none = site({}, []);
  expect(await findAbout(H, none.read)).toBeNull();
  expect(none.reads).toEqual([`${H}sitemap.xml`, `${H}about`, `${H}about-us`]);
});

test("a sitemap address that fails to read gives no about page, and nothing more is tried", async () => {
  const s = site({ [`${H}sitemap.xml`]: { index: false, locs: [`${H}about`] } }, []);
  expect(await findAbout(H, s.read)).toBeNull();
  expect(s.reads).toHaveLength(2);
});

test("never more than 6 reads", async () => {
  const children = Array.from({ length: 10 }, (_, i) => `${H}s${i}.xml`);
  const maps: Record<string, Sitemap> = { [`${H}sitemap.xml`]: { index: true, locs: children } };
  for (const c of children) maps[c] = { index: false, locs: [] };
  const s = site(maps, []);
  await findAbout(H, s.read);
  expect(s.reads.length).toBeLessThanOrEqual(6);
});
