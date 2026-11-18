// SPDX-License-Identifier: AGPL-3.0-only
import { withWorkspace, type WorkspaceTx } from "@direx/db";
import { actions, credentials, items } from "@direx/db/schema";
import { socialAccountHealth, socialAccounts, socialPosts } from "@direx/db/schema-social";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, ne, not, or, sql } from "drizzle-orm";

export const inWorkspace = withWorkspace;

/** Each target with its credential. A deleted credential's targets don't show, however it was deleted. */
export const listAccounts = (tx: WorkspaceTx) =>
  tx
    .select({
      id: socialAccounts.id,
      credentialId: socialAccounts.credentialId,
      connection: socialAccounts.connection,
      accountType: socialAccounts.accountType,
      networkId: socialAccounts.networkId,
      name: socialAccounts.name,
      lastCheckedAt: socialAccounts.lastCheckedAt,
      status: credentials.status,
      ownerUserId: credentials.ownerUserId,
      expiresAt: credentials.expiresAt,
      meta: credentials.meta,
      runBy: socialAccounts.runBy,
      angle: socialAccounts.angle,
    })
    .from(socialAccounts)
    .innerJoin(credentials, eq(credentials.id, socialAccounts.credentialId))
    .where(isNull(credentials.deletedAt))
    .orderBy(asc(socialAccounts.createdAt));

export const targetIds = async (tx: WorkspaceTx, credentialId: string) =>
  (await tx.select({ networkId: socialAccounts.networkId }).from(socialAccounts).where(eq(socialAccounts.credentialId, credentialId))).map((r) => r.networkId);

export async function insertTargets(tx: WorkspaceTx, workspaceId: string, credentialId: string, connection: string, targets: { id: string; name: string; type: string; angle?: string | null }[], now: Date) {
  if (!targets.length) return;
  await tx
    .insert(socialAccounts)
    .values(targets.map((t) => ({ workspaceId, credentialId, connection, accountType: t.type, networkId: t.id, name: t.name, lastCheckedAt: now, angle: t.angle ?? null })))
    .onConflictDoNothing();
}

/** Live accounts on one network in the Workspace. */
export const accountsOn = async (tx: WorkspaceTx, connection: string) =>
  (
    await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(socialAccounts)
      .innerJoin(credentials, eq(credentials.id, socialAccounts.credentialId))
      .where(and(eq(socialAccounts.connection, connection), isNull(credentials.deletedAt)))
  )[0]?.n ?? 0;

export const accountAbout = async (tx: WorkspaceTx, id: string) => {
  const [row] = await tx.select({ connection: socialAccounts.connection, runBy: socialAccounts.runBy, angle: socialAccounts.angle }).from(socialAccounts).where(eq(socialAccounts.id, id));
  return row ?? null;
};

export const setAbout = (tx: WorkspaceTx, id: string, about: { runBy: string | null; angle: string | null }) => tx.update(socialAccounts).set(about).where(eq(socialAccounts.id, id));

/** Who the account says runs it, and how many accounts share its network here, for the disclosure warning. */
export const runByOf = async (tx: WorkspaceTx, connection: string, credentialId: string, networkId: string) => {
  const [row] = await tx
    .select({ runBy: socialAccounts.runBy })
    .from(socialAccounts)
    .where(and(eq(socialAccounts.credentialId, credentialId), eq(socialAccounts.networkId, networkId)));
  return row ? { runBy: row.runBy, onNetwork: await accountsOn(tx, connection) } : null;
};

export const deleteTargets = (tx: WorkspaceTx, credentialId: string) => tx.delete(socialAccounts).where(eq(socialAccounts.credentialId, credentialId));

export const touchChecked = (tx: WorkspaceTx, credentialId: string, at: Date) =>
  tx.update(socialAccounts).set({ lastCheckedAt: at }).where(and(eq(socialAccounts.credentialId, credentialId)));

export type SocialTx = WorkspaceTx;

export const accountOf = async (tx: WorkspaceTx, credentialId: string, networkId: string) => {
  const [row] = await tx
    .select({ name: socialAccounts.name, meta: credentials.meta })
    .from(socialAccounts)
    .innerJoin(credentials, eq(credentials.id, socialAccounts.credentialId))
    .where(and(eq(socialAccounts.credentialId, credentialId), eq(socialAccounts.networkId, networkId), isNull(credentials.deletedAt)));
  return row ?? null;
};

/** A step's post on one account, and whether it was cancelled, which no draft can revise. */
export const existingPost = async (tx: WorkspaceTx, campaignId: string, stepKey: string, connection: string, networkId: string, clipId: string | null = null) => {
  const [row] = await tx
    .select({ id: socialPosts.id, itemId: socialPosts.itemId, actionId: socialPosts.actionId, cancelled: sql<boolean>`coalesce(${actions.state}, ${items.state}) = 'cancelled'` })
    .from(socialPosts)
    .innerJoin(items, eq(items.id, socialPosts.itemId))
    .leftJoin(actions, eq(actions.id, socialPosts.actionId))
    .where(and(eq(socialPosts.campaignId, campaignId), eq(socialPosts.stepKey, stepKey), eq(socialPosts.connection, connection), eq(socialPosts.networkId, networkId), clipId ? eq(socialPosts.clipId, clipId) : isNull(socialPosts.clipId)));
  return row ?? null;
};

/**
 * Puts a new post in a cancelled one's place on its step: rows are never deleted, and one account has one place per
 * step. The cancelled Item keeps its history; the old link and its card go, as they belonged to the old text.
 */
export const replacePost = (tx: WorkspaceTx, id: string, row: typeof socialPosts.$inferInsert) =>
  tx
    .update(socialPosts)
    .set({ credentialId: row.credentialId ?? null, accountName: row.accountName ?? null, itemId: row.itemId, actionId: row.actionId ?? null, createdAt: row.createdAt, postedUrl: null, linkPreview: null, linkImage: null, linkImageType: null })
    .where(eq(socialPosts.id, id));

export const insertPost = (tx: WorkspaceTx, row: typeof socialPosts.$inferInsert) => tx.insert(socialPosts).values(row).onConflictDoNothing();

export const specOfAction = async (tx: WorkspaceTx, actionId: string) => {
  const [row] = await tx.select({ spec: actions.spec }).from(actions).where(eq(actions.id, actionId));
  return row?.spec ?? null;
};

/** Another step's post on this account near this time. A cancelled or ended one no longer crowds it. */
export const withinSlot = async (tx: WorkspaceTx, a: { connection: string; networkId: string; except: { campaignId: string; stepKey: string } | null; at: Date; ms: number }) => {
  const seconds = a.ms / 1000;
  const [row] = await tx
    .select({ id: socialPosts.id })
    .from(socialPosts)
    .innerJoin(items, eq(items.id, socialPosts.itemId))
    .leftJoin(actions, eq(actions.id, socialPosts.actionId))
    .where(
      and(
        eq(socialPosts.connection, a.connection),
        eq(socialPosts.networkId, a.networkId),
        a.except ? not(and(eq(socialPosts.campaignId, a.except.campaignId), eq(socialPosts.stepKey, a.except.stepKey))!) : undefined,
        sql`coalesce(${actions.state}, ${items.state}) <> 'cancelled'`,
        sql`abs(extract(epoch from (coalesce(${actions.dueAt}, ${items.plannedAt}) - ${a.at.toISOString()}::timestamptz))) < ${seconds}`,
      ),
    )
    .limit(1);
  return !!row;
};

/** The account and network one post's Item goes out as. */
export const postOfItem = (tx: WorkspaceTx, itemId: string) =>
  tx
    .select({ id: socialPosts.id, accountName: socialPosts.accountName, connection: socialPosts.connection, linkPreview: socialPosts.linkPreview, hasImage: sql<boolean>`${socialPosts.linkImage} is not null` })
    .from(socialPosts)
    .where(eq(socialPosts.itemId, itemId))
    .limit(1);
/** One post with what it says now, for a person's edit of its text. */
export const postToEdit = async (tx: WorkspaceTx, itemId: string) => {
  const [row] = await tx
    .select({ campaignId: socialPosts.campaignId, stepKey: socialPosts.stepKey, connection: socialPosts.connection, networkId: socialPosts.networkId, credentialId: socialPosts.credentialId, actionId: socialPosts.actionId, spec: actions.spec, payload: items.payload })
    .from(socialPosts)
    .innerJoin(items, eq(items.id, socialPosts.itemId))
    .leftJoin(actions, eq(actions.id, socialPosts.actionId))
    .where(eq(socialPosts.itemId, itemId));
  return row ?? null;
};
/** Keeps what a post's first link showed, and its image, so it's read once per link. */
export const keepPreview = (tx: WorkspaceTx, postId: string, kept: unknown, image: { type: string; bytes: Buffer } | null) =>
  tx.update(socialPosts).set({ linkPreview: kept, linkImage: image?.bytes ?? null, linkImageType: image?.type ?? null }).where(eq(socialPosts.id, postId));
/** The image a post's link card shows, if it has one. */
export const linkImageOf = (tx: WorkspaceTx, itemId: string) =>
  tx.select({ bytes: socialPosts.linkImage, type: socialPosts.linkImageType }).from(socialPosts).where(and(eq(socialPosts.itemId, itemId), isNotNull(socialPosts.linkImage))).limit(1);

export const listPosts = (tx: WorkspaceTx, campaignId: string, stepKey: string) =>
  tx
    .select({ id: socialPosts.id, itemId: socialPosts.itemId, actionId: socialPosts.actionId, clipId: socialPosts.clipId, connection: socialPosts.connection, accountName: socialPosts.accountName, postedUrl: socialPosts.postedUrl, spec: actions.spec, result: actions.result, state: actions.state, payload: items.payload })
    .from(socialPosts)
    .innerJoin(items, eq(items.id, socialPosts.itemId))
    .leftJoin(actions, eq(actions.id, socialPosts.actionId))
    .where(and(eq(socialPosts.campaignId, campaignId), eq(socialPosts.stepKey, stepKey)))
    .orderBy(asc(socialPosts.createdAt));

export const markManualPosted = (tx: WorkspaceTx, itemId: string, url: string | null) => tx.update(socialPosts).set({ postedUrl: url }).where(eq(socialPosts.itemId, itemId));

/** A Workspace's own app for this connection, the row the vault reads first. */
export const ownAppExists = async (tx: WorkspaceTx, connection: string) => {
  const [row] = await tx.select({ id: credentials.id }).from(credentials).where(and(eq(credentials.key, `oauth_app:${connection}`), isNull(credentials.deletedAt))).limit(1);
  return !!row;
};

/** A connected account by its id, with what identifies it to the network. */
export const accountById = async (tx: WorkspaceTx, id: string) => {
  const [row] = await tx.select({ credentialId: socialAccounts.credentialId, networkId: socialAccounts.networkId }).from(socialAccounts).where(eq(socialAccounts.id, id));
  return row ?? null;
};

/** Which account an Action posts to. Null for an Action that isn't a social post. */
export const postAccountOf = async (tx: WorkspaceTx, actionId: string) => {
  const [row] = await tx.select({ credentialId: socialPosts.credentialId, networkId: socialPosts.networkId }).from(socialPosts).where(eq(socialPosts.actionId, actionId));
  return row?.credentialId ? { credentialId: row.credentialId, networkId: row.networkId } : null;
};

type Spec = { text?: unknown; followUps?: unknown };

/** What this account published, or may have, in [from, to): its posts through Direx other than this Action, and the ones a person marked posted by hand. */
export async function specsPostedBetween(tx: WorkspaceTx, a: { credentialId: string; networkId: string }, exceptActionId: string | null, from: Date, to: Date): Promise<Spec[]> {
  const direct = (
    await tx
      .select({ spec: actions.spec })
      .from(socialPosts)
      .innerJoin(actions, eq(actions.id, socialPosts.actionId))
      .where(
        and(
          eq(socialPosts.credentialId, a.credentialId),
          eq(socialPosts.networkId, a.networkId),
          exceptActionId ? ne(actions.id, exceptActionId) : undefined,
          gte(actions.firstDispatchedAt, from),
          lt(actions.firstDispatchedAt, to),
          or(inArray(actions.state, ["sent", "dispatching"]), isNotNull(actions.outcomeUnknownAt)),
        ),
      )
  ).map((r) => (r.spec ?? {}) as Spec);
  // ponytail: a hand post counts on the day its Item was last updated, which is when it was marked posted; store a posted-at time if that ever drifts.
  const byHand = (
    await tx
      .select({ payload: items.payload })
      .from(socialPosts)
      .innerJoin(items, eq(items.id, socialPosts.itemId))
      .where(and(eq(socialPosts.credentialId, a.credentialId), eq(socialPosts.networkId, a.networkId), isNull(socialPosts.actionId), eq(items.state, "applied"), gte(items.updatedAt, from), lt(items.updatedAt, to)))
  ).map((r) => (r.payload ?? {}) as Spec);
  return [...direct, ...byHand];
}

export type HealthRow = typeof socialAccountHealth.$inferSelect;
type Account = { credentialId: string; networkId: string };
const healthOfAccount = (a: Account) => and(eq(socialAccountHealth.credentialId, a.credentialId), eq(socialAccountHealth.networkId, a.networkId));

/** An account's health, created at the floor the first time anyone asks. */
export async function healthOf(tx: WorkspaceTx, workspaceId: string, a: Account, floor: { posts: number; replies: number; links: number }, now: Date): Promise<HealthRow> {
  await tx
    .insert(socialAccountHealth)
    .values({ workspaceId, ...a, ...floor, cleanSince: now, updatedAt: now })
    .onConflictDoNothing();
  const [row] = await tx.select().from(socialAccountHealth).where(healthOfAccount(a));
  return row!;
}

/** Every health row under one login. */
export const healthOfCredential = (tx: WorkspaceTx, credentialId: string) => tx.select().from(socialAccountHealth).where(eq(socialAccountHealth.credentialId, credentialId));

/** An account's health row, or null before anyone has checked it. Never creates one. */
export const peekHealth = async (tx: WorkspaceTx, a: { credentialId: string; networkId: string }) => (await tx.select().from(socialAccountHealth).where(healthOfAccount(a)))[0] ?? null;

export const updateHealth = (tx: WorkspaceTx, a: Account, set: Partial<Omit<HealthRow, "workspaceId" | "credentialId" | "networkId">>) =>
  tx.update(socialAccountHealth).set(set).where(healthOfAccount(a));

/** Posts that went out, or may have, this UTC month, counting each follow-up. */
export const postsInMonth = async (tx: WorkspaceTx, capability: string, exceptActionId: string, now: Date) => {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await tx
    .select({ n: sql<number>`coalesce(sum(1 + coalesce(jsonb_array_length(${actions.spec} -> 'followUps'), 0)), 0)::int` })
    .from(actions)
    .where(and(eq(actions.capability, capability), ne(actions.id, exceptActionId), gte(actions.firstDispatchedAt, start), or(inArray(actions.state, ["sent", "dispatching"]), isNotNull(actions.outcomeUnknownAt))));
  return row?.n ?? 0;
};
