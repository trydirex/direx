// SPDX-License-Identifier: AGPL-3.0-only
// Account health: each connected account publishes no more in a day than its budget, and stops when
// the network warns. It lowers the risk of a restriction; nothing here can promise there won't be one.
import { storedSpec } from "@direx/plugin-sdk/host";
import type { Check } from "../../ledger/index";
import { localTime, mailboxDay, nextDay } from "../../schedule";
import { accountById, healthOf, healthOfCredential, inWorkspace, peekHealth, postAccountOf, specsPostedBetween, updateHealth, workspaceZone, type HealthRow, type SocialTx } from "../adapters/repo";
import { atFloor, capOf, CLEAN_DAYS_PER_STEP, ESTABLISHED, FLOOR, halve, overBudget, spendOf, step, type Budget, type Use } from "../domain/budget";

const NOUN = { posts: "posts", links: "links" } as const;


export const budgetOf = (h: HealthRow): Budget => ({ posts: h.posts, replies: h.replies, links: h.links });

export function usedOf(specs: readonly { text?: unknown; followUps?: unknown }[]): Use {
  const used = { posts: 0, replies: 0, links: 0 };
  for (const s of specs) {
    const spent = spendOf(s);
    used.posts += spent.posts;
    used.replies += spent.replies;
    used.links += spent.links;
  }
  return used;
}

const DAY = 24 * 60 * 60_000;

/** What an account used on the Workspace's day holding `at`, other than one Action (ADR 0038). */
export const usedOnDay = async (tx: SocialTx, workspaceId: string, account: { credentialId: string; networkId: string }, exceptActionId: string | null, at: Date) => {
  const timeZone = await workspaceZone(tx, workspaceId);
  const on = mailboxDay(at, timeZone);
  return usedOf(await specsPostedBetween(tx, account, exceptActionId, localTime(on, 0, timeZone), localTime(nextDay(on), 0, timeZone)));
};

/** A hand post can't be held, since the person posts it, so over budget it only warns. Null when it fits. */
export async function handPostWarning(tx: SocialTx, workspaceId: string, account: { credentialId: string; networkId: string }, payload: { text?: unknown; followUps?: unknown }, plannedAt: Date, now: Date) {
  const health = await healthOf(tx, workspaceId, account, FLOOR, now);
  const over = overBudget(budgetOf(health), await usedOnDay(tx, workspaceId, account, null, plannedAt), spendOf(payload));
  if (health.pausedAt) return "This account is paused after a warning from the network. Posting by hand risks it further.";
  return over && `${over.used} of ${over.budget} ${NOUN[over.key]} that day on this account. Posting more by hand raises the risk of a restriction.`;
}

/** Holds a post when its account is paused or has used today's budget. A person moves it on. */
export const accountHealthCheck =
  (deps: { now: () => Date }): Check =>
  async (rawTx, action) => {
    const tx = rawTx as SocialTx;
    const account = await postAccountOf(tx, action.id);
    if (!account) return { kind: "ok" };
    const now = deps.now();
    const health = await healthOf(tx, action.workspaceId, account, FLOOR, now);
    if (health.pausedAt) return { kind: "hold", reason: "account_paused", detail: health.pauseDetail ?? health.pauseReason ?? undefined };
    const used = await usedOnDay(tx, action.workspaceId, account, action.id, now);
    const over = overBudget(budgetOf(health), used, spendOf(storedSpec("social.publish", action.spec)));
    return over ? { kind: "hold", reason: "account_budget_reached", detail: `${over.used} of ${over.budget} ${NOUN[over.key]} today on this account` } : { kind: "ok" };
  };

/** A warning sign: pause the account and halve its budget. Only a person lifts the pause. */
export async function pauseAccount(tx: SocialTx, workspaceId: string, account: { credentialId: string; networkId: string }, why: { reason: string; detail?: string | undefined }, now: Date) {
  const health = await healthOf(tx, workspaceId, account, FLOOR, now);
  // A second sign while paused changes nothing: halving twice for one incident would punish a retry storm.
  if (health.pausedAt) return;
  await updateHealth(tx, account, { ...halve(budgetOf(health)), pausedAt: now, pauseReason: why.reason, pauseDetail: why.detail ?? null, updatedAt: now });
}

/** The same, outside a ledger transaction: a person reporting a removal. */
export const pauseInWorkspace = (workspaceId: string, account: { credentialId: string; networkId: string }, why: { reason: string; detail?: string | undefined }, now: Date) =>
  inWorkspace(workspaceId, (tx) => pauseAccount(tx, workspaceId, account, why, now));

/** The ledger's hook: a network's throttle or spam block pauses the account that posted. Other Actions pass through. */
export const pauseOnAccountLimit =
  (deps: { now: () => Date }) =>
  async (rawTx: unknown, action: { id: string; workspaceId: string }, limit: "sending_limit" | "abuse", detail: string | undefined) => {
    const tx = rawTx as SocialTx;
    const account = await postAccountOf(tx, action.id);
    if (account) await pauseAccount(tx, action.workspaceId, account, { reason: limit, detail }, deps.now());
  };

/** A person lifts a pause. The budget stays halved, and clean days count from now. */
async function unpauseIn(tx: SocialTx, workspaceId: string, account: { credentialId: string; networkId: string }, now: Date) {
  await healthOf(tx, workspaceId, account, FLOOR, now);
  await updateHealth(tx, account, { pausedAt: null, pauseReason: null, pauseDetail: null, cleanSince: now, updatedAt: now });
}
export const unpauseAccount = (workspaceId: string, account: { credentialId: string; networkId: string }, now: Date) => inWorkspace(workspaceId, (tx) => unpauseIn(tx, workspaceId, account, now));

type Who = { workspaceId: string; accountId: string; now: Date };
const byId = <T>(w: Who, f: (tx: SocialTx, account: { credentialId: string; networkId: string }) => Promise<T>) =>
  inWorkspace(w.workspaceId, async (tx) => {
    const account = await accountById(tx, w.accountId);
    return account ? { ok: true as const, value: await f(tx, account) } : { ok: false as const, reason: "not_found" as const };
  });

/** A person says a post was removed or the account restricted: the same as a network's warning. */
export const reportRemoved = (w: Who, note: string | null) =>
  byId(w, (tx, account) => pauseAccount(tx, w.workspaceId, account, { reason: "removed", detail: note ?? "A person reported a removal or restriction" }, w.now));

/** A person lifts a pause by id. */
export const unpauseById = (w: Who) => byId(w, (tx, account) => unpauseIn(tx, w.workspaceId, account, w.now));

/** A person's lower limits; null clears one. Today's budget drops to a new limit at once. Nothing here can raise a budget. */
export const setLowerLimits = (w: Who, lower: Partial<Record<keyof Budget, number | null>>) =>
  byId(w, async (tx, account) => {
    const h = await healthOf(tx, w.workspaceId, account, FLOOR, w.now);
    const next = { postsLower: lower.posts === undefined ? h.postsLower : lower.posts, repliesLower: lower.replies === undefined ? h.repliesLower : lower.replies, linksLower: lower.links === undefined ? h.linksLower : lower.links };
    const cap = capOf({ posts: next.postsLower ?? undefined, replies: next.repliesLower ?? undefined, links: next.linksLower ?? undefined });
    await updateHealth(tx, account, { ...next, posts: Math.min(h.posts, cap.posts), replies: Math.min(h.replies, cap.replies), links: Math.min(h.links, cap.links), updatedAt: w.now });
  });

const lowerOf = (h: HealthRow) => ({ posts: h.postsLower ?? undefined, replies: h.repliesLower ?? undefined, links: h.linksLower ?? undefined });

/** A new account's first budget: the floor, or a higher start for one a person calls established. */
export const startHealth = (tx: SocialTx, workspaceId: string, account: { credentialId: string; networkId: string }, established: boolean, now: Date) =>
  healthOf(tx, workspaceId, account, established ? ESTABLISHED : FLOOR, now);

/**
 * A person says an account connected earlier is established. It moves to the established start only
 * while it is at the floor and not paused, so it can't undo a warning's halving or skip the ramp.
 */
export const markEstablished = (w: Who) =>
  byId(w, async (tx, account) => {
    const h = await healthOf(tx, w.workspaceId, account, FLOOR, w.now);
    if (h.pausedAt || !atFloor(budgetOf(h))) return false;
    const cap = capOf(lowerOf(h));
    await updateHealth(tx, account, { posts: Math.min(ESTABLISHED.posts, cap.posts), replies: Math.min(ESTABLISHED.replies, cap.replies), links: Math.min(ESTABLISHED.links, cap.links), cleanSince: w.now, updatedAt: w.now });
    return true;
  });

/** The daily sweep: each unpaused account under this login with a run of clean days grows one step. */
export const stepUpCredential = (workspaceId: string, credentialId: string, now: Date) =>
  inWorkspace(workspaceId, async (tx) => {
    for (const h of await healthOfCredential(tx, credentialId)) {
      if (h.pausedAt) continue;
      const clean = Math.floor((now.getTime() - h.cleanSince.getTime()) / DAY);
      if (clean < CLEAN_DAYS_PER_STEP) continue;
      const next = step(budgetOf(h), clean, lowerOf(h));
      await updateHealth(tx, { credentialId: h.credentialId, networkId: h.networkId }, { ...next, cleanSince: now, updatedAt: now });
    }
  });

/** What the accounts page shows: today's use against the budget, and why it is paused. A read changes nothing. */
export const healthLine = (workspaceId: string, account: { credentialId: string; networkId: string }, now: Date) =>
  inWorkspace(workspaceId, async (tx) => {
    const h = await peekHealth(tx, account);
    const used = await usedOnDay(tx, workspaceId, account, null, now);
    return {
      budget: h ? budgetOf(h) : FLOOR,
      used: { posts: used.posts, links: used.links },
      paused: h?.pausedAt ? { at: h.pausedAt, reason: h.pauseReason ?? "", detail: h.pauseDetail } : null,
    };
  });
