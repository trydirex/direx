// SPDX-License-Identifier: AGPL-3.0-only
// A connect link lets one person connect an account from a device where Direx isn't signed in, such
// as a phone already signed in to that account. It works once, briefly, and carries the Workspace in
// both its URL and the OAuth `state`, so every lookup runs inside that Workspace.

/** [DEFAULT] How long a link can be opened and claimed. */
export const LINK_TTL_MS = 15 * 60_000;
/** [DEFAULT] Unclaimed, unexpired links one person may hold per connection. */
export const MAX_OPEN_LINKS = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const isLinkToken = (t: string) => TOKEN.test(t);
export const isWorkspaceId = (id: string) => UUID.test(id);

/** The `state` a link connect sends: the Workspace, a dot, then a random part. */
export const linkState = (workspaceId: string, random: string) => `${workspaceId}.${random}`;

/** The Workspace a link connect's `state` names, or null for any other `state`. */
export function linkWorkspace(state: string | undefined): string | null {
  const [ws, random, extra] = (state ?? "").split(".");
  return ws && random && extra === undefined && UUID.test(ws) && TOKEN.test(random) ? ws : null;
}

export type LinkRow = { expiresAt: Date; claimedAt: Date | null; usedAt: Date | null; credentialId: string | null };
export type LinkStatus = "open" | "claimed" | "connected" | "failed" | "expired";

/** What a link's issuer sees: still waiting, being used, done, or dead. `claimWindowMs` is how long a claimed link waits for the network. */
export function linkStatus(l: LinkRow, now: Date, claimWindowMs: number): LinkStatus {
  if (l.usedAt) return l.credentialId ? "connected" : "failed";
  if (l.claimedAt) return l.claimedAt.getTime() + claimWindowMs <= now.getTime() ? "expired" : "claimed";
  return l.expiresAt <= now ? "expired" : "open";
}
