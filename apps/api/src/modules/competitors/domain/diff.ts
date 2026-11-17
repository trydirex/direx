// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what changed between two reads of one page. Lines are compared as sets, so a moved line is
// not a change. A redesign is one "page rewritten" Change, not hundreds.
import type { LandingParts } from "./parts";

/**
 * A page is rewritten when more lines than this change at once and they are over half the page
 * [DEFAULT]. Both, because Double's weekly entry alone is about 40 lines of a 500-line changelog (2026-11-11).
 */
export const REWRITE_LINES = 30;
const rewritten = (changed: number, pageLines: number) => changed > REWRITE_LINES && changed * 2 > pageLines;
/** A landing part back to a value from this many good reads is a flip, not news (A/B headlines, E3). */
export const LANDING_MEMORY = 4;

export type LandingPart = keyof LandingParts;
export type ChangeDetail =
  | { added: string[]; removed?: string[] }
  | { part: LandingPart; before: string | null; after: string | null }
  | { rewritten: { added: number; removed: number } };

const missing = (from: string[], into: string[]) => {
  const have = new Set(into);
  return from.filter((l) => !have.has(l));
};

/** A changelog's new lines only: old entries scrolling off the page is not news. */
export function changelogChange(before: string[], after: string[]): ChangeDetail | null {
  const added = missing(after, before);
  if (added.length === 0) return null;
  return rewritten(added.length, after.length) ? { rewritten: { added: added.length, removed: 0 } } : { added };
}

/** A pricing page's lines added and removed: a price that goes away is news too. */
export function pricingChange(before: string[], after: string[]): ChangeDetail | null {
  const added = missing(after, before);
  const removed = missing(before, after);
  if (added.length + removed.length === 0) return null;
  return rewritten(added.length + removed.length, Math.max(before.length, after.length)) ? { rewritten: { added: added.length, removed: removed.length } } : { added, removed };
}

const PARTS: LandingPart[] = ["title", "description", "headline", "subhead"];

/**
 * One Change per landing part that differs from the last good read, unless the new value is one of
 * the last LANDING_MEMORY good reads' values. `history` is newest first.
 */
export function landingChanges(history: LandingParts[], after: LandingParts): ChangeDetail[] {
  const last = history[0];
  if (!last) return [];
  const recent = history.slice(0, LANDING_MEMORY);
  return PARTS.filter((p) => after[p] !== last[p] && !recent.some((h) => h[p] === after[p])).map((part) => ({ part, before: last[part], after: after[part] }));
}
