// SPDX-License-Identifier: AGPL-3.0-only
// Pure: which account posts which clip, and when. Clips go out best first, round robin over the accounts,
// so no clip lands on two accounts and no account gets the same clip twice.

export type ClipAccount = { connection: string; credentialId: string | null; networkId: string | null };
export type SpreadClip = { id: string; mediaId: string; caption: string; citations: readonly string[] };
export type ClipPost = ClipAccount & { clipId: string; mediaId: string; text: string; at: Date; citations: { factId: string; version: number }[] };

const DAY_MS = 86_400_000;
/** [DEFAULT] An account posts at most one clip a day, for at most a week from the first post. */
export const CLIP_DAYS = 7;
/** [DEFAULT] Accounts on one network go out this far apart, so they never share a slot. */
export const SAME_NETWORK_GAP_MS = 30 * 60_000;

const cited = (c: string) => {
  const at = c.lastIndexOf("@");
  return { factId: c.slice(0, at), version: Number(c.slice(at + 1)) };
};

const sameAccount = (a: ClipAccount, b: ClipAccount) => a.connection === b.connection && a.credentialId === b.credentialId && a.networkId === b.networkId;

/**
 * Each clip, best first, goes to the account with the earliest free day, the first account on a tie, so
 * with nothing taken clip i goes to account i mod n on day i div n. A day is free when the account has
 * no post less than a day from it, counting `taken`: the posts the step's earlier recordings planned.
 * A post goes at the first post time plus its day, plus half an hour for each account before it on the
 * same network. Clips with no free day in the week are unposted; accounts given no clip are idle.
 */
export function spreadClips(clips: readonly SpreadClip[], accounts: readonly ClipAccount[], firstAt: Date, taken: readonly (ClipAccount & { at: Date })[] = []): { posts: ClipPost[]; unposted: string[]; idle: ClipAccount[] } {
  if (!accounts.length) return { posts: [], unposted: clips.map((c) => c.id), idle: [] };
  const offset = accounts.map((a, i) => accounts.slice(0, i).filter((b) => b.connection === a.connection).length * SAME_NETWORK_GAP_MS);
  const timeOf = (k: number, day: number) => firstAt.getTime() + day * DAY_MS + offset[k]!;
  const busy = accounts.map((a) => taken.filter((t) => sameAccount(t, a)).map((t) => t.at.getTime()));
  const free = (k: number, day: number) => busy[k]!.every((t) => Math.abs(t - timeOf(k, day)) >= DAY_MS);
  const next = accounts.map(() => 0);
  const used = new Set<number>();
  const posts: ClipPost[] = [];
  const unposted: string[] = [];
  for (const clip of clips) {
    next.forEach((_, k) => {
      while (next[k]! < CLIP_DAYS && !free(k, next[k]!)) next[k]!++;
    });
    const k = next.indexOf(Math.min(...next));
    if (next[k]! >= CLIP_DAYS) {
      unposted.push(clip.id);
      continue;
    }
    posts.push({ ...accounts[k]!, clipId: clip.id, mediaId: clip.mediaId, text: clip.caption, at: new Date(timeOf(k, next[k]!)), citations: clip.citations.map(cited) });
    used.add(k);
    next[k]!++;
  }
  return { posts, unposted, idle: accounts.filter((_, k) => !used.has(k)) };
}
