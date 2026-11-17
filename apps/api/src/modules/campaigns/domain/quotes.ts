// SPDX-License-Identifier: AGPL-3.0-only
// A detail about a recipient counts only if the page it names says it, word for word, so the reader
// can't add anything of its own. A quote that carries an address is dropped: links come from Facts.

export const DETAIL_KINDS = ["what_they_do", "who_they_serve", "product", "recent_news", "location"] as const;
export type Detail = { kind: (typeof DETAIL_KINDS)[number]; page: "home" | "about"; quote: string };
export type PageText = { label: "home" | "about"; text: string };

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

/** A link, a bare domain such as `acme.co`, an email address, or a merge field. */
const CARRIES_ADDRESS = /:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,}\b|@|\{\{|\}\}/i;
export const carriesAddress = (quote: string) => CARRIES_ADDRESS.test(quote);

export function quotedOn(quote: string, page: string): boolean {
  const q = norm(quote);
  return q.length > 0 && norm(page).includes(q);
}

/** The details the writer may see, and how many were dropped, for the run's record. */
export function keptDetails(details: readonly Detail[], pages: readonly PageText[]): { kept: Detail[]; dropped: number } {
  const kept = details.filter((d) => !CARRIES_ADDRESS.test(d.quote) && pages.some((p) => p.label === d.page && quotedOn(d.quote, p.text)));
  return { kept, dropped: details.length - kept.length };
}
