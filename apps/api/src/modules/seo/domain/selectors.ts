// SPDX-License-Identifier: AGPL-3.0-only
// Which pages and queries are worth a brief, picked from a property's own search rows. Pure:
// the rows come in, ranked candidates go out, and the numbers stay exactly as Google gave them.

export type SearchRow = { keys: string[]; clicks: number; impressions: number; position: number };
export type Ranked<T> = { total: number; top: T[] };
export type NearPageOne = { query: string; page: string; clicks: number; impressions: number; position: number };
export type Slipping = { page: string; query: string; impressionsBefore: number; impressionsNow: number };
export type Competing = { query: string; impressions: number; pages: { page: string; clicks: number; impressions: number; position: number }[] };

export const SELECTOR_RULES = {
  /** Each selector returns at most this many, best first. */
  cap: 20,
  nearPageOne: { minPosition: 8, maxPosition: 20, minImpressions: 20 },
  /** Impressions now at most this share of before, from at least `minBefore`. */
  slipping: { maxShareNow: 0.7, minBefore: 200 },
  competing: { minPages: 2, minImpressionsEach: 10 },
};

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, "");

/** The Workspace name and the property's domain label: `Contoso` and `contosohq` for `sc-domain:contosohq.example`. */
export function brandTerms(workspaceName: string, siteUrl: string): string[] {
  const host = siteUrl.startsWith("sc-domain:") ? siteUrl.slice("sc-domain:".length) : URL.canParse(siteUrl) ? new URL(siteUrl).hostname : "";
  const label = host.replace(/^www\./, "").split(".")[0] ?? "";
  return [...new Set([squash(workspaceName), squash(label)])].filter((t) => t.length >= 3);
}

export const isBrand = (query: string, terms: string[]) => {
  const q = squash(query);
  return q.startsWith("site:") || terms.some((t) => q.includes(t));
};

const ranked = <T>(all: T[], score: (x: T) => number): Ranked<T> => ({ total: all.length, top: [...all].sort((a, b) => score(b) - score(a)).slice(0, SELECTOR_RULES.cap) });

/** Rows by query and page whose query isn't brand. */
const nonBrand = (rows: SearchRow[], terms: string[]) => rows.filter((r) => !isBrand(r.keys[0] ?? "", terms));

/** Query and page pairs just off page one: average position 8 to 20, with enough impressions to matter. */
export function nearPageOne(queryPageRows: SearchRow[], terms: string[]): Ranked<NearPageOne> {
  const { minPosition, maxPosition, minImpressions } = SELECTOR_RULES.nearPageOne;
  const picked = nonBrand(queryPageRows, terms)
    .filter((r) => r.position >= minPosition && r.position <= maxPosition && r.impressions >= minImpressions)
    .map((r) => ({ query: r.keys[0]!, page: r.keys[1]!, clicks: r.clicks, impressions: r.impressions, position: r.position }));
  return ranked(picked, (c) => c.impressions);
}

/**
 * Pages whose impressions fell by 30% or more against the window before. Page totals include
 * brand searches; the page's top non-brand query now is attached, and a page without one is left out.
 */
export function slipping(pagesNow: SearchRow[], pagesBefore: SearchRow[], queryPageRows: SearchRow[], terms: string[]): Ranked<Slipping> {
  const { maxShareNow, minBefore } = SELECTOR_RULES.slipping;
  const now = new Map(pagesNow.map((r) => [r.keys[0]!, r.impressions]));
  const topQuery = new Map<string, SearchRow>();
  for (const r of nonBrand(queryPageRows, terms)) {
    const best = topQuery.get(r.keys[1]!);
    if (!best || r.impressions > best.impressions) topQuery.set(r.keys[1]!, r);
  }
  const picked = pagesBefore.flatMap((r) => {
    const page = r.keys[0]!;
    const impressionsNow = now.get(page) ?? 0;
    const query = topQuery.get(page)?.keys[0];
    return r.impressions >= minBefore && impressionsNow <= maxShareNow * r.impressions && query !== undefined ? [{ page, query, impressionsBefore: r.impressions, impressionsNow }] : [];
  });
  return ranked(picked, (c) => c.impressionsBefore - c.impressionsNow);
}

/** Queries that two or more of the site's pages each get real impressions for. */
export function competing(queryPageRows: SearchRow[], terms: string[]): Ranked<Competing> {
  const { minPages, minImpressionsEach } = SELECTOR_RULES.competing;
  const byQuery = new Map<string, Competing["pages"]>();
  for (const r of nonBrand(queryPageRows, terms)) {
    if (r.impressions < minImpressionsEach) continue;
    const pages = byQuery.get(r.keys[0]!) ?? [];
    pages.push({ page: r.keys[1]!, clicks: r.clicks, impressions: r.impressions, position: r.position });
    byQuery.set(r.keys[0]!, pages);
  }
  const picked = [...byQuery].filter(([, pages]) => pages.length >= minPages).map(([query, pages]) => ({ query, impressions: pages.reduce((n, p) => n + p.impressions, 0), pages: pages.sort((a, b) => b.impressions - a.impressions) }));
  return ranked(picked, (c) => c.impressions);
}
