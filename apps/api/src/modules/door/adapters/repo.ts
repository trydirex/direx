// SPDX-License-Identifier: AGPL-3.0-only
// External tokens in the database, every query inside one Workspace under forced RLS. Token events
// go in the Workspace audit log in the same transaction, as credentials' removals do.
import { withWorkspace, type WorkspaceTx } from "@direx/db";
import { workspaceAudit, workspaceMembers } from "@direx/db/schema";
import { DOOR_OUTCOMES, doorCounters, doorRequests, externalTokens } from "@direx/db/schema-door";
import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";

export const inWorkspace = withWorkspace;

export type NewToken = typeof externalTokens.$inferInsert;
type Audit = { event: "external_token.created" | "external_token.revoked"; tokenId: string; actorUserId: string; stepUp: boolean; at: Date };

export async function insertToken(tx: WorkspaceTx, t: NewToken & { id: string; workspaceId: string; createdAt: Date }) {
  await tx.insert(externalTokens).values(t);
  await audit(tx, t.workspaceId, { event: "external_token.created", tokenId: t.id, actorUserId: t.createdBy, stepUp: true, at: t.createdAt });
}

const audit = (tx: WorkspaceTx, workspaceId: string, a: Audit) =>
  tx.insert(workspaceAudit).values({ workspaceId, event: a.event, subjectTokenId: a.tokenId, actorUserId: a.actorUserId, stepUp: a.stepUp, at: a.at });

/** Every token with its creator's role now, or null once they left. Never the hash. */
export function listTokens(tx: WorkspaceTx) {
  return tx
    .select({
      id: externalTokens.id,
      name: externalTokens.name,
      hint: externalTokens.hint,
      readers: externalTokens.readers,
      kinds: externalTokens.kinds,
      createdBy: externalTokens.createdBy,
      createdAt: externalTokens.createdAt,
      expiresAt: externalTokens.expiresAt,
      revokedBy: externalTokens.revokedBy,
      revokedAt: externalTokens.revokedAt,
      lastUsedAt: externalTokens.lastUsedAt,
      creatorRole: workspaceMembers.role,
    })
    .from(externalTokens)
    .leftJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, externalTokens.workspaceId), eq(workspaceMembers.userId, externalTokens.createdBy)))
    .orderBy(desc(externalTokens.createdAt), desc(externalTokens.id));
}

/** Revokes once; a second revoke changes nothing and writes no second audit row. */
export async function revokeToken(tx: WorkspaceTx, workspaceId: string, tokenId: string, userId: string, at: Date): Promise<boolean> {
  const exists = await tx.select({ id: externalTokens.id }).from(externalTokens).where(eq(externalTokens.id, tokenId));
  if (!exists.length) return false;
  const done = await tx
    .update(externalTokens)
    .set({ revokedBy: userId, revokedAt: at })
    .where(and(eq(externalTokens.id, tokenId), isNull(externalTokens.revokedAt)))
    .returning({ id: externalTokens.id });
  if (done.length) await audit(tx, workspaceId, { event: "external_token.revoked", tokenId, actorUserId: userId, stepUp: false, at });
  return true;
}

/** The unrevoked token with this hash, with its creator's role now. */
export async function findByHash(tx: WorkspaceTx, tokenHash: string) {
  const rows = await tx
    .select({
      id: externalTokens.id,
      name: externalTokens.name,
      readers: externalTokens.readers,
      kinds: externalTokens.kinds,
      expiresAt: externalTokens.expiresAt,
      creatorRole: workspaceMembers.role,
    })
    .from(externalTokens)
    .leftJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, externalTokens.workspaceId), eq(workspaceMembers.userId, externalTokens.createdBy)))
    .where(and(eq(externalTokens.tokenHash, tokenHash), isNull(externalTokens.revokedAt)));
  return rows[0] ?? null;
}

/** A creator's tokens still unrevoked and unexpired at `at`, each given a stop row in the audit log. */
export async function recordStops(tx: WorkspaceTx, workspaceId: string, createdBy: string, at: Date) {
  const live = await tx
    .select({ id: externalTokens.id, name: externalTokens.name })
    .from(externalTokens)
    .where(and(eq(externalTokens.createdBy, createdBy), isNull(externalTokens.revokedAt), gt(externalTokens.expiresAt, at)))
    .orderBy(externalTokens.createdAt, externalTokens.id);
  if (live.length)
    await tx.insert(workspaceAudit).values(live.map((t) => ({ workspaceId, event: "external_token.stopped", subjectTokenId: t.id, actorSystem: "membership_change", at })));
  return live;
}

/** Records a use, at most once per `every` ms, so a poller doesn't write on each request. */
export async function touch(tx: WorkspaceTx, tokenId: string, at: Date, everyMs: number) {
  await tx
    .update(externalTokens)
    .set({ lastUsedAt: at })
    .where(and(eq(externalTokens.id, tokenId), or(isNull(externalTokens.lastUsedAt), lt(externalTokens.lastUsedAt, new Date(at.getTime() - everyMs)))));
}

export type DoorOutcome = (typeof DOOR_OUTCOMES)[number];

/** Adds one to a scope's count for this minute and returns the new count, in one statement. */
export async function bumpCounter(tx: WorkspaceTx, workspaceId: string, scope: string, minute: Date): Promise<number> {
  const [row] = await tx
    .insert(doorCounters)
    .values({ workspaceId, scope, minute, count: 1 })
    .onConflictDoUpdate({ target: [doorCounters.workspaceId, doorCounters.scope, doorCounters.minute], set: { count: sql`${doorCounters.count} + 1` } })
    .returning({ count: doorCounters.count });
  return row!.count;
}

/** Counts older than `before` decide nothing any more. */
export const pruneCounters = (tx: WorkspaceTx, workspaceId: string, before: Date) =>
  tx.delete(doorCounters).where(and(eq(doorCounters.workspaceId, workspaceId), lt(doorCounters.minute, before)));

/** `operation` and the older `reader` get the same name until a later release drops `reader` (DX-R-0029-005). */
export const insertRequest = (tx: WorkspaceTx, r: { workspaceId: string; tokenId: string; reader: string; outcome: DoorOutcome; at: Date }) => tx.insert(doorRequests).values({ ...r, operation: r.reader });

/** A token's latest requests, newest first: reader, outcome and time only. */
export const recentRequests = (tx: WorkspaceTx, tokenId: string, limit: number) =>
  tx
    .select({ reader: doorRequests.reader, outcome: doorRequests.outcome, at: doorRequests.at })
    .from(doorRequests)
    .where(eq(doorRequests.tokenId, tokenId))
    .orderBy(desc(doorRequests.id))
    .limit(limit);
