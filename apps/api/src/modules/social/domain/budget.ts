// SPDX-License-Identifier: AGPL-3.0-only
// How much one account may publish in a day. It starts low, grows one step after a run of clean
// days, halves when the network warns, and never passes the ceiling. Every number is a guess the
// pilot will replace: the networks publish their abuse limits, not the level that gets an account
// flagged, and that level is far lower.

export type Budget = { posts: number; replies: number; links: number };
export type Use = Budget;

/** [DEFAULT] Where a new or newly paused account starts. */
export const FLOOR: Budget = { posts: 1, replies: 3, links: 0 };
/** [DEFAULT] The most any account may reach, below every network's documented limit. */
export const CEILING: Budget = { posts: 5, replies: 20, links: 3 };
/** [DEFAULT] Where an account a person calls established starts: older, already posting, so above the floor. */
export const ESTABLISHED: Budget = { posts: 3, replies: 10, links: 1 };

/** Whether an account may still be called established: only while it sits at the floor. */
export const atFloor = (b: Budget) => b.posts === FLOOR.posts && b.replies === FLOOR.replies && b.links === FLOOR.links;
/** [DEFAULT] Clean days before a budget grows by one. */
export const CLEAN_DAYS_PER_STEP = 7;

const KEYS = ["posts", "replies", "links"] as const;
const each = (f: (k: (typeof KEYS)[number]) => number): Budget => ({ posts: f("posts"), replies: f("replies"), links: f("links") });

/** The cap that applies: the ceiling, or a person's lower limit where they set one. */
export const capOf = (lower: Partial<Budget> | null): Budget => each((k) => Math.min(CEILING[k], lower?.[k] ?? CEILING[k]));

/** One more of each after enough clean days, up to the cap. */
export const step = (b: Budget, cleanDays: number, lower: Partial<Budget> | null): Budget =>
  cleanDays < CLEAN_DAYS_PER_STEP ? b : each((k) => Math.min(b[k] + 1, capOf(lower)[k]));

/** Half of each, rounded down, never below the floor. */
export const halve = (b: Budget): Budget => each((k) => Math.max(FLOOR[k], Math.floor(b[k] / 2)));

/** What one post spends: a post, its follow-ups as replies, and a link if it carries one. */
export const spendOf = (spec: { text?: unknown; followUps?: unknown }): Use => {
  const text = typeof spec.text === "string" ? spec.text : "";
  const followUps = Array.isArray(spec.followUps) ? spec.followUps.map(String) : [];
  // ponytail: a URL in the text is a link; a network's own link cards don't show up here, add them if a plugin sends one.
  const hasLink = [text, ...followUps].some((t) => /https?:\/\/\S/i.test(t));
  return { posts: 1, replies: followUps.length, links: hasLink ? 1 : 0 };
};

/** The first budget this post would pass, or null when it fits. Replies are stored, not enforced, until Direx publishes replies. */
export function overBudget(b: Budget, used: Use, spend: Use): { key: "posts" | "links"; used: number; budget: number } | null {
  for (const key of ["posts", "links"] as const) {
    if (spend[key] > 0 && used[key] + spend[key] > b[key]) return { key, used: used[key], budget: b[key] };
  }
  return null;
}
