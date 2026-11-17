// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what a competitor on the list may hold, and how many a Workspace may have.

export const MAX_COMPETITORS = 5;
export const MAX_NAME_CHARS = 100;
export const MAX_URL_CHARS = 2000;

export const SOURCES = ["pricing", "changelog", "landing"] as const;
export type Source = (typeof SOURCES)[number];

/** `comparisonUrl` is our own page comparing us with them: optional, checked like the others, never read weekly. */
export type CompetitorFields = { name: string; comparisonUrl?: string | null } & Record<`${Source}Url`, string | null>;
export type FieldProblem = "name_missing" | "name_length" | "bad_url" | "no_url";

const isWebAddress = (raw: string) => {
  if (raw.length > MAX_URL_CHARS) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

/** The first rule a competitor breaks, or null. Any host is allowed: changelogs live on other services. */
export function checkFields(f: CompetitorFields): FieldProblem | null {
  const name = f.name.trim();
  if (name.length < 1) return "name_missing";
  if (name.length > MAX_NAME_CHARS) return "name_length";
  const urls = SOURCES.map((s) => f[`${s}Url`]).filter((u): u is string => u !== null);
  if (urls.length === 0) return "no_url";
  return [...urls, ...(f.comparisonUrl ? [f.comparisonUrl] : [])].every(isWebAddress) ? null : "bad_url";
}

export const MAX_PRICES_SHOWN = 6;

/**
 * The prices in a page's text, each once, in page order, up to MAX_PRICES_SHOWN. A price is a currency
 * sign or code next to a number: "$15", "15 USD", "€9.99". Shown to the person so they can see which
 * prices were found: an add-on's price alone means the plans were drawn by a script (r64: Double).
 */
export function pricesIn(text: string): string[] {
  const found = [...text.matchAll(/[$€£]\s?\d[\d.,]*|\d[\d.,]*\s?(?:USD|EUR|GBP)\b/gi)].map((m) => m[0].replace(/\s+/g, " ").replace(/[.,]$/, ""));
  return [...new Set(found)].slice(0, MAX_PRICES_SHOWN);
}

export const hasPrice = (text: string) => pricesIn(text).length > 0;
