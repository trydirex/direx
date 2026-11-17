// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what the names reader is shown, and which of the people it reports are kept. Its reply is
// untrusted, so a name counts only when the company's own pages hold it.
import type { PageText } from "./signals";

export type NamedPerson = { first: string; last: string; role: string | null };

/** People kept per company. */
export const MAX_PEOPLE = 2;
/** The most page text one names run is shown, in characters. */
export const MAX_NAMES_CHARS = 8_000;

// One or more words of letters, each allowing an apostrophe, hyphen or dot inside it, such as O'Neil or Anne-Marie.
const NAME = /^\p{L}[\p{L}\p{M}'’.-]*(?: \p{L}[\p{L}\p{M}'’.-]*){0,3}$/u;
const MAX_PART = 40;

/**
 * Lowercased words with single spaces between them and at both ends, so a match is a whole word. A
 * hyphen or apostrophe inside a word joins it, so Jan Doe isn't found in Jan Doe-Smith.
 */
const words = (text: string) =>
  ` ${text
    .normalize("NFC")
    .toLowerCase()
    .replace(/(?<=\p{L})['’-](?=\p{L})/gu, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()} `;

const shaped = (part: string) => part.length <= MAX_PART && NAME.test(part);

/** The pages as one text, each under its address, cut to what one run is shown. */
export function namesText(domain: string, pages: readonly PageText[]): string {
  const text = [`Company website: ${domain}`, ...pages.map((p) => `Page ${p.url}:\n${p.text}`)].join("\n\n");
  return text.slice(0, MAX_NAMES_CHARS);
}

/**
 * The reported people whose name is on the pages, in the order given, once each and at most two.
 * A first name alone counts when no last name was reported.
 */
export function keptPeople(reported: readonly NamedPerson[], pages: readonly PageText[]): NamedPerson[] {
  const onPages = pages.map((p) => words(p.text));
  const seen = new Set<string>();
  const kept: NamedPerson[] = [];
  for (const p of reported) {
    const first = p.first.trim().replace(/\s+/g, " ");
    const last = p.last.trim().replace(/\s+/g, " ");
    if (!shaped(first) || (last && !shaped(last))) continue;
    const name = words(`${first} ${last}`);
    if (seen.has(name) || !onPages.some((text) => text.includes(name))) continue;
    seen.add(name);
    kept.push({ first, last, role: p.role?.trim() || null });
    if (kept.length === MAX_PEOPLE) break;
  }
  return kept;
}
