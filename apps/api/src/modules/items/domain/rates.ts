// SPDX-License-Identifier: AGPL-3.0-only
// Pure: a reviewer's own pace and how often they change what they read. Faster while changing less can
// mean reading stopped, so it is said to them. It never blocks a decision.

export type ReviewDecision = { decision: string; openedAt: Date; decidedAt: Date };

/** Why a person turned a draft down ("Not like this"), each counted against its Campaign step. */
export const REVIEW_REASONS = ["salesy", "long", "facts", "voice", "audience"] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];
/** A reason with the person's optional sentence. `great` is praise on approve, kept but not used yet. */
export type ReasonGiven = { reason: ReviewReason | "great"; note?: string | undefined };
export const MAX_REASON_NOTE = 300;
export type ReviewRates = { decisions: number; medianSeconds: number | null; changedShare: number | null; warning: boolean };

const WINDOW = 50;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const seconds = (d: ReviewDecision) => (d.decidedAt.getTime() - d.openedAt.getTime()) / 1000;
const changed = (ds: readonly ReviewDecision[]) => ds.filter((d) => d.decision !== "approve").length / ds.length;

/**
 * Rates over the newest 50 decisions (newest first). The warning needs the 50 before them too: it holds
 * when the median time per item fell by half or more and the share edited or rejected fell by half or more.
 */
export function reviewRates(newestFirst: readonly ReviewDecision[]): ReviewRates {
  const recent = newestFirst.slice(0, WINDOW);
  const before = newestFirst.slice(WINDOW, 2 * WINDOW);
  if (!recent.length) return { decisions: 0, medianSeconds: null, changedShare: null, warning: false };
  const pace = median(recent.map(seconds));
  const share = changed(recent);
  const full = recent.length === WINDOW && before.length === WINDOW;
  const warning = full && changed(before) > 0 && pace <= median(before.map(seconds)) / 2 && share <= changed(before) / 2;
  return { decisions: recent.length, medianSeconds: pace, changedShare: share, warning };
}
