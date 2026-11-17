// SPDX-License-Identifier: AGPL-3.0-only
// What a draft says in numbers, against what it can show for them. A number with no source warns. An
// amount of money no price Fact holds needs a person's decision, because a wrong price is a promise.
// A comma inside a number groups digits; one after it ends the clause, as in "£4,500, paid once".
const NUMBER = /(?<![\w.,])[$€£]?\d(?:[\d,]*\d)?(?:\.\d+)?%?/g;
const MERGE_FIELD = /\{\{[^}]*\}\}/g;

// "$ 15" on a website and "$15" in a draft are one price.
const SPACED_CURRENCY = /([$€£])\s+(?=\d)/g;

export const numbersIn = (text: string): string[] => [...new Set(text.replace(MERGE_FIELD, " ").replace(SPACED_CURRENCY, "$1").match(NUMBER) ?? [])];
const isMoney = (n: string) => /^[$€£]/.test(n);

export function reviewClaims(text: string, cited: readonly string[], prices: readonly string[]): { uncited: string[]; conflicts: string[] } {
  const sourced = new Set(cited.flatMap(numbersIn));
  const known = new Set(prices.flatMap(numbersIn));
  const unsourced = numbersIn(text).filter((n) => !sourced.has(n));
  const conflicts = prices.length ? unsourced.filter((n) => isMoney(n) && !known.has(n)) : [];
  return { uncited: unsourced.filter((n) => !conflicts.includes(n)), conflicts };
}
