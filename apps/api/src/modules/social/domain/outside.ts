// SPDX-License-Identifier: AGPL-3.0-only
// Posts a Social account published outside Direx (ADR 0039): whose a read post is, which kinds are
// kept and for how long, and where the account's reading stands.

export type Origin = "outside" | "own" | "possibly_own";

export type OwnRecords = { refs: ReadonlySet<string>; urls: ReadonlySet<string>; sent: ReadonlySet<string>; pending: ReadonlySet<string> };

/** Whose post this is: Direx's own by id, link or exact text; possibly own while a send is unsettled. */
export const originOf = (post: { id: string; permalink?: string; text: string }, own: OwnRecords): Origin => {
  const text = post.text.trim();
  if (own.refs.has(post.id) || (post.permalink !== undefined && own.urls.has(post.permalink)) || own.sent.has(text)) return "own";
  return own.pending.has(text) ? "possibly_own" : "outside";
};

/** The kinds stored; replies and reposts are dropped before insert. */
export const keptKinds = ["original", "quote"] as const;
export type KeptKind = (typeof keptKinds)[number];
export const isKept = (kind: string): kind is KeptKind => (keptKinds as readonly string[]).includes(kind);

/** When a post read now is swept: its created time plus the network's days. */
export const keepUntil = (postedAt: Date, days: number): Date => new Date(postedAt.getTime() + days * 86_400_000);

export type ReadState =
  | { state: "not_checked" } // the account's plugin can't list its posts
  | { state: "first_read" } // no successful read yet, or the first one is running
  | { state: "failed"; reason: string | null; at: Date | null } // the latest read failed; at is the last success
  | { state: "stale"; at: Date } // no successful read in twice the interval
  | { state: "ok"; at: Date }; // read within twice the interval

/** Where an account's reading stands, from its social_accounts row. */
export const readState = (
  row: { postsReadAt: Date | null; postsReadState: string | null; postsReadReason: string | null; postsCursor: string | null },
  now: Date,
  intervalMs: number,
  canRead: boolean,
): ReadState => {
  if (!canRead) return { state: "not_checked" };
  if (row.postsReadState === "failed") return { state: "failed", reason: row.postsReadReason, at: row.postsReadAt };
  if (row.postsReadAt === null || (row.postsReadState === "reading" && row.postsCursor === null)) return { state: "first_read" };
  if (now.getTime() - row.postsReadAt.getTime() > 2 * intervalMs) return { state: "stale", at: row.postsReadAt };
  return { state: "ok", at: row.postsReadAt };
};
