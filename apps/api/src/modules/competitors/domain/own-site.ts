// SPDX-License-Identifier: AGPL-3.0-only
// Pure: competitor names from the Workspace's own sitemap. A page named "double-alternative" or
// "equility-vs-double" names a competitor, read from the address alone with no model. A name comes
// with a site only when our page links to it; Direx never guesses one from the name.

export type NamedPage = { slug: string; url: string };

const SLUG = /^[a-z0-9]+(-[a-z0-9]+){0,2}$/;
const isSlug = (s: string | null): s is string => !!s && s.length >= 2 && s.length <= 40 && SLUG.test(s);
const host = (url: string) => new URL(url).hostname.toLowerCase().replace(/^www\./, "");

/** The site's own names: equilityhq.com is "equilityhq" and "equility". */
export function ownNames(site: string): string[] {
  const label = host(site).split(".")[0]!;
  const bare = label.replace(/(hq|app|io|ai)$/, "");
  return bare.length >= 3 && bare !== label ? [label, bare] : [label];
}

/** The competitor a page's address names, or null. `x-vs-y` counts only when one side is us. */
function slugOf(url: string, own: readonly string[]): string | null {
  const parts = new URL(url).pathname.toLowerCase().split("/").filter(Boolean);
  const last = parts.at(-1);
  if (!last) return null;
  if (parts.length >= 2 && (parts.at(-2) === "compare" || parts.at(-2) === "vs")) return last;
  const m = /^(.+)-alternatives?$/.exec(last) ?? /^alternatives?-to-(.+)$/.exec(last) ?? /^(.+)-comparison$/.exec(last) ?? /^vs-(.+)$/.exec(last);
  if (m) return m[1]!;
  const [x, y, ...more] = last.split("-vs-");
  if (more.length || !y) return null;
  return own.includes(x!) ? y : own.includes(y) ? x! : null;
}

/** One page per competitor named in the sitemap, the shortest address first, never ourselves. */
export function namesFromSitemap(locs: readonly string[], own: readonly string[]): NamedPage[] {
  const out = new Map<string, NamedPage>();
  for (const url of [...locs].sort((a, b) => a.length - b.length)) {
    const slug = slugOf(url, own);
    if (isSlug(slug) && !own.includes(slug) && !out.has(slug)) out.set(slug, { slug, url });
  }
  return [...out.values()];
}

/** "booke-ai" reads as "Booke Ai"; the person can fix the name when they use it. */
export const nameOf = (slug: string) => slug.replace(/(^|-)([a-z0-9])/g, (_, dash: string, c: string) => (dash ? " " : "") + c.toUpperCase());

/** One key for every way of writing a name: "Booke AI", "booke-ai" and "BookeAI" are one. */
export const nameKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 100);

/** A site compares as its host, without www. */
export const siteKey = (url: string) => host(url);

/** The competitor's own site, when our comparison page links to one whose name holds the slug's letters. */
export function siteFromLinks(slug: string, links: readonly string[], ownSite: string): string | null {
  const letters = slug.replace(/-/g, "");
  const ours = host(ownSite);
  for (const link of links) {
    const h = host(link);
    if (h !== ours && !h.endsWith(`.${ours}`) && h.split(".")[0]!.includes(letters)) return new URL(link).origin + "/";
  }
  return null;
}
