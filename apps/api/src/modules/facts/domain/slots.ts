// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what a fact can be about. A slot is a field and a subject, and holds one live fact. A
// `competitor` fact is about a watched competitor (subject: its name), quoted from its own page.

export const FIELDS = ["what_you_sell", "who_buys", "tone", "price", "claim", "never_say", "competitor"] as const;
export type Field = (typeof FIELDS)[number];
export type Confidence = "low" | "medium" | "high";
export type Source = { kind: "person" | "website" | "document" | "chat" | "edits"; label: string; url?: string; retrievedAt?: string };

const SINGLE: readonly Field[] = ["what_you_sell", "who_buys", "tone"];

/** The longest value a person may type: the same cap the brand reader writes under. */
export const MAX_FACT_CHARS = 1000;

/**
 * A single-value field has no subject. A many-value field without one is known by its own
 * words, so a claim needs no name of its own.
 */
export function subjectOf(field: Field, subject: string | undefined, value: string): string {
  if (SINGLE.includes(field)) return "";
  return (subject?.trim() || value).trim().replace(/\s+/g, " ").toLowerCase();
}

/** Two values that differ only in spacing say the same thing. */
export const sameWords = (a: string, b: string) => a.trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ");

const FILLER = new Set(["a", "an", "and", "as", "for", "of", "the", "to", "we", "our", "with"]);
const SAME_WORDS_SHARE = 0.5;
const wordsOf = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !FILLER.has(w)));

/**
 * Whether a value Direx read says what's already there. A description read twice comes back in new
 * words, and that's no contradiction. Any other field has to match, because a different price or
 * claim is a different fact, and so does any number.
 * ponytail: shared words, not meaning, so "small charities" and "large charities" count as the same.
 * The cost is a Brand that stays as a person left it. A model check can replace this if that bites.
 */
export function saysTheSame(field: Field, a: string, b: string): boolean {
  if (sameWords(a, b)) return true;
  if (!SINGLE.includes(field)) return false;
  const [x, y] = [wordsOf(a), wordsOf(b)];
  const numbers = (w: Set<string>) => [...w].filter((t) => /\d/.test(t)).sort().join();
  if (numbers(x) !== numbers(y)) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared > 0 && shared / new Set([...x, ...y]).size >= SAME_WORDS_SHARE;
}
