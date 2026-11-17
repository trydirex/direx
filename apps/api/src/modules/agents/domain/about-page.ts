// SPDX-License-Identifier: AGPL-3.0-only
// Which about page a run reads. Code picks it, never a model, so a page can't steer what is fetched.
// The sitemap is asked first; only when it names nothing are the two usual addresses tried.

const NAMES = new Set(["about", "about-us"]);
const MAX_CHILD_SITEMAPS = 3;

export type Sitemap = { index: boolean; locs: string[] } | null;
export type AboutReads<P> = { sitemap: (url: string) => Promise<Sitemap>; page: (url: string) => Promise<P | null> };

const lastSegment = (address: string) => new URL(address).pathname.replace(/\/+$/, "").split("/").pop()!.toLowerCase();

/** The shortest listed address whose last part is `about` or `about-us`, so `/en/about-us/` counts. */
export function aboutIn(locs: readonly string[]): string | null {
  const named = locs.filter((l) => NAMES.has(lastSegment(l)));
  return named.reduce<string | null>((best, l) => (best === null || new URL(l).pathname.length < new URL(best).pathname.length ? l : best), null);
}

/** At most 6 reads: the sitemap, 3 child sitemaps, then the about page or the two fallbacks. */
export async function findAbout<P>(home: string, read: AboutReads<P>): Promise<P | null> {
  const top = await read.sitemap(new URL("/sitemap.xml", home).href);
  let found: string | null = null;
  if (top && !top.index) found = aboutIn(top.locs);
  if (top?.index) {
    const children = [...top.locs].sort((a, b) => Number(b.includes("page")) - Number(a.includes("page"))).slice(0, MAX_CHILD_SITEMAPS);
    for (const child of children) {
      const map = await read.sitemap(child);
      found = map && !map.index ? aboutIn(map.locs) : null;
      if (found) break;
    }
  }
  if (found) return read.page(found);
  for (const path of ["/about", "/about-us"]) {
    const page = await read.page(new URL(path, home).href);
    if (page) return page;
  }
  return null;
}
