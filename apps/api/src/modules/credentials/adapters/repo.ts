// SPDX-License-Identifier: AGPL-3.0-only
// Queries on the vault tables. Every function takes the caller's withWorkspace transaction,
// so a read, its access event and any write commit together.
import { withSystem, type WorkspaceTx } from "@direx/db";
import { approvalKeys, connectLinks, credentialAccessEvents, credentials, deploymentRootKey, workspaceAudit, workspaceKeys, workspaceMembers, organizations, workspaces } from "@direx/db/schema";
import { placementMemberKeys } from "@direx/db/schema-placement";
import { and, asc, desc, eq, gt, gte, isNull, sql } from "drizzle-orm";

export { withWorkspace, type WorkspaceTx } from "@direx/db";
// Read at start, beside the root key and the system secrets (ADR 0029 rule 008).
export { migrationsPending, type MigrationState } from "@direx/db";

/** A unique violation, as node-postgres reports it through drizzle. */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return (err.code ?? err.cause?.code) === "23505";
}

/** The root key this deployment first ran with. It holds no tenant data, so any Workspace context reads it. */
export async function readDeploymentRootKey(tx: WorkspaceTx): Promise<string | undefined> {
  const [row] = await tx.select({ id: deploymentRootKey.rootKeyId }).from(deploymentRootKey);
  return row?.id;
}

/** Workspaces whose active data key another root key wrapped, so this deployment can't read their vault. */
export async function workspacesKeyedByOtherRoot(rootKeyId: string): Promise<string[]> {
  const { rows } = await withSystem((tx) => tx.execute(sql`select workspace_id from system.workspaces_keyed_by_other_root(${rootKeyId})`));
  return rows.map((r) => r.workspace_id as string);
}

/** Moves the recorded root key from one id to another. False while any data key is under some other root key. */
export async function replaceDeploymentRootKey(fromId: string, toId: string): Promise<boolean> {
  const { rows } = await withSystem((tx) => tx.execute(sql`select system.replace_deployment_root_key(${fromId}, ${toId}) as replaced`));
  return rows[0]?.replaced === true;
}

/** Records the root key unless one is already recorded; returns the one that stands. */
export async function recordDeploymentRootKey(tx: WorkspaceTx, rootKeyId: string, now: Date): Promise<string> {
  await tx.insert(deploymentRootKey).values({ rootKeyId, createdAt: now }).onConflictDoNothing();
  return (await readDeploymentRootKey(tx))!;
}

export type ApprovalKeyRow = typeof approvalKeys.$inferSelect;

export const listApprovalKeys = (tx: WorkspaceTx, workspaceId: string): Promise<ApprovalKeyRow[]> =>
  tx.select().from(approvalKeys).where(eq(approvalKeys.workspaceId, workspaceId));

/** False when another process created the Workspace's live key first. */
export async function insertApprovalKey(tx: WorkspaceTx, row: typeof approvalKeys.$inferInsert): Promise<boolean> {
  return (await tx.insert(approvalKeys).values(row).onConflictDoNothing().returning({ id: approvalKeys.keyId })).length > 0;
}

export type MemberKeyRow = typeof placementMemberKeys.$inferSelect;

export async function memberKeyRow(tx: WorkspaceTx, credentialId: string): Promise<MemberKeyRow | undefined> {
  const [row] = await tx.select().from(placementMemberKeys).where(eq(placementMemberKeys.credentialId, credentialId));
  return row;
}

/** False when another process made this Mailbox's key first. */
export async function insertMemberKey(tx: WorkspaceTx, row: typeof placementMemberKeys.$inferInsert): Promise<boolean> {
  return (await tx.insert(placementMemberKeys).values(row).onConflictDoNothing().returning({ id: placementMemberKeys.credentialId })).length > 0;
}

export type CredentialRow = typeof credentials.$inferSelect;
export type NewCredential = typeof credentials.$inferInsert;
export type AccessEvent = Omit<typeof credentialAccessEvents.$inferInsert, "id">;

export async function activeKey(tx: WorkspaceTx, workspaceId: string) {
  const [row] = await tx
    .select()
    .from(workspaceKeys)
    .where(and(eq(workspaceKeys.workspaceId, workspaceId), isNull(workspaceKeys.retiredAt)));
  return row ?? null;
}

export async function keyByVersion(tx: WorkspaceTx, workspaceId: string, keyVersion: number) {
  const [row] = await tx
    .select()
    .from(workspaceKeys)
    .where(and(eq(workspaceKeys.workspaceId, workspaceId), eq(workspaceKeys.keyVersion, keyVersion)));
  return row ?? null;
}

/** Every data key of a Workspace, retired ones too. */
export const keysOf = (tx: WorkspaceTx, workspaceId: string) => tx.select().from(workspaceKeys).where(eq(workspaceKeys.workspaceId, workspaceId));

/** Stores a data key as another root key wrapped it. */
export async function rewrapKey(tx: WorkspaceTx, workspaceId: string, keyVersion: number, wrappedDek: Buffer, rootKeyId: string) {
  await tx.update(workspaceKeys).set({ wrappedDek, rootKeyId }).where(and(eq(workspaceKeys.workspaceId, workspaceId), eq(workspaceKeys.keyVersion, keyVersion)));
}

/** Inserts the Workspace's first data key; a concurrent first write loses quietly and reads the winner's. */
export async function insertFirstKey(tx: WorkspaceTx, row: typeof workspaceKeys.$inferInsert) {
  await tx.insert(workspaceKeys).values(row).onConflictDoNothing();
}

export async function insertCredential(tx: WorkspaceTx, row: NewCredential) {
  const [out] = await tx.insert(credentials).values(row).returning();
  return out!;
}

/** With `lock`, holds the row until the transaction ends, so only one worker refreshes it. */
export async function findCredential(tx: WorkspaceTx, workspaceId: string, id: string, lock = false) {
  const q = tx
    .select()
    .from(credentials)
    .where(and(eq(credentials.workspaceId, workspaceId), eq(credentials.id, id)));
  const [row] = lock ? await q.for("update") : await q;
  return row ?? null;
}

/** By id alone, for callers that hold only the transaction; RLS keeps it to the Workspace. */
export async function credentialById(tx: WorkspaceTx, id: string) {
  const [row] = await tx.select().from(credentials).where(eq(credentials.id, id));
  return row ?? null;
}

/** A person's live credential under a key, such as the mailbox they are reconnecting. */
export async function findLiveUserKey(tx: WorkspaceTx, workspaceId: string, ownerUserId: string, key: string) {
  const [row] = await tx
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.workspaceId, workspaceId),
        eq(credentials.scope, "user"),
        eq(credentials.ownerUserId, ownerUserId),
        eq(credentials.key, key),
        isNull(credentials.deletedAt),
      ),
    );
  return row ?? null;
}

/** Writes only when the row is live and still at `version`; returns the new row or null. */
export async function updateLive(
  tx: WorkspaceTx,
  workspaceId: string,
  id: string,
  version: number,
  set: Partial<NewCredential>,
) {
  const [row] = await tx
    .update(credentials)
    .set({ ...set, version: sql`${credentials.version} + 1` })
    .where(
      and(
        eq(credentials.workspaceId, workspaceId),
        eq(credentials.id, id),
        eq(credentials.version, version),
        isNull(credentials.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** Serialize app changes with callback persistence, including when there is no app row to lock. */
export async function lockWorkspaceApp(tx: WorkspaceTx, workspaceId: string, connection: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["oauth-app", workspaceId, connection])}, 0))`);
}

/** Every live, active token for one connection in this Workspace now needs a person to reconnect it. */
export async function markConnectionNeedsReauth(tx: WorkspaceTx, workspaceId: string, connection: string, at: Date) {
  await tx
    .update(credentials)
    .set({ status: "needs_reauth", updatedAt: at, version: sql`${credentials.version} + 1` })
    .where(
      and(
        eq(credentials.workspaceId, workspaceId),
        eq(credentials.connection, connection),
        eq(credentials.kind, "oauth2"),
        eq(credentials.status, "active"),
        isNull(credentials.deletedAt),
      ),
    );
}

export async function touchUsed(tx: WorkspaceTx, workspaceId: string, id: string, at: Date) {
  await tx
    .update(credentials)
    .set({ lastUsedAt: at })
    .where(and(eq(credentials.workspaceId, workspaceId), eq(credentials.id, id)));
}

export async function isMember(tx: WorkspaceTx, workspaceId: string, userId: string) {
  const [row] = await tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  return Boolean(row);
}

export async function insertEvent(tx: WorkspaceTx, e: AccessEvent) {
  await tx.insert(credentialAccessEvents).values(e);
}

export async function insertLink(tx: WorkspaceTx, row: typeof connectLinks.$inferInsert) {
  await tx.insert(connectLinks).values(row);
}

/** Links a person still holds for a connection: not claimed and not expired. */
export async function openLinkCount(tx: WorkspaceTx, workspaceId: string, userId: string, connection: string, now: Date) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(connectLinks)
    .where(and(eq(connectLinks.workspaceId, workspaceId), eq(connectLinks.issuedBy, userId), eq(connectLinks.connection, connection), isNull(connectLinks.claimedAt), gt(connectLinks.expiresAt, now)));
  return row?.n ?? 0;
}

/** A link that can still be claimed, with what its page shows. */
export async function claimableLink(tx: WorkspaceTx, workspaceId: string, tokenHash: string, now: Date) {
  const [row] = await tx
    .select({ id: connectLinks.id, issuedBy: connectLinks.issuedBy, connection: connectLinks.connection, workspaceName: workspaces.name })
    .from(connectLinks)
    .innerJoin(workspaces, eq(workspaces.workspaceId, connectLinks.workspaceId))
    .where(and(eq(connectLinks.workspaceId, workspaceId), eq(connectLinks.tokenHash, tokenHash), isNull(connectLinks.claimedAt), gt(connectLinks.expiresAt, now), isNull(workspaces.deletedAt)));
  return row ?? null;
}

/** Claims a link in one statement, so two devices can't both use it; null when someone was first. */
export async function claimLink(tx: WorkspaceTx, workspaceId: string, id: string, now: Date, state: { stateHash: string; sealedState: string }) {
  const [row] = await tx
    .update(connectLinks)
    .set({ claimedAt: now, ...state })
    .where(and(eq(connectLinks.workspaceId, workspaceId), eq(connectLinks.id, id), isNull(connectLinks.claimedAt), gt(connectLinks.expiresAt, now)))
    .returning({ id: connectLinks.id });
  return row ?? null;
}

/**
 * Uses up the link a network's callback names: its sealed state is returned once and erased, so a
 * replayed callback finds nothing. Claimed before `claimedAfter` counts as gone.
 */
export async function useLinkByState(tx: WorkspaceTx, workspaceId: string, stateHash: string, now: Date, claimedAfter: Date) {
  const [row] = await tx
    .select({ id: connectLinks.id, issuedBy: connectLinks.issuedBy, sealedState: connectLinks.sealedState })
    .from(connectLinks)
    .where(and(eq(connectLinks.workspaceId, workspaceId), eq(connectLinks.stateHash, stateHash), isNull(connectLinks.usedAt), gt(connectLinks.claimedAt, claimedAfter)))
    .for("update");
  if (!row?.sealedState) return null;
  await tx.update(connectLinks).set({ usedAt: now, stateHash: null, sealedState: null }).where(eq(connectLinks.id, row.id));
  return { id: row.id, issuedBy: row.issuedBy, sealedState: row.sealedState };
}

export async function setLinkCredential(tx: WorkspaceTx, workspaceId: string, id: string, credentialId: string) {
  await tx.update(connectLinks).set({ credentialId }).where(and(eq(connectLinks.workspaceId, workspaceId), eq(connectLinks.id, id)));
}

/** A person's links made since `since`, newest first, with the connected account's name once there is one. */
export function linksOf(tx: WorkspaceTx, workspaceId: string, userId: string, since: Date) {
  return tx
    .select({
      id: connectLinks.id,
      connection: connectLinks.connection,
      expiresAt: connectLinks.expiresAt,
      claimedAt: connectLinks.claimedAt,
      usedAt: connectLinks.usedAt,
      credentialId: connectLinks.credentialId,
      accountName: credentials.name,
      createdAt: connectLinks.createdAt,
    })
    .from(connectLinks)
    .leftJoin(credentials, and(eq(credentials.workspaceId, connectLinks.workspaceId), eq(credentials.id, connectLinks.credentialId)))
    .where(and(eq(connectLinks.workspaceId, workspaceId), eq(connectLinks.issuedBy, userId), gte(connectLinks.createdAt, since)))
    .orderBy(desc(connectLinks.createdAt));
}

export function listLive(tx: WorkspaceTx, workspaceId: string) {
  return tx
    .select()
    .from(credentials)
    .where(and(eq(credentials.workspaceId, workspaceId), isNull(credentials.deletedAt)))
    .orderBy(asc(credentials.name), asc(credentials.id));
}

export function listEvents(tx: WorkspaceTx, workspaceId: string, credentialId: string, limit: number) {
  return tx
    .select()
    .from(credentialAccessEvents)
    .where(and(eq(credentialAccessEvents.workspaceId, workspaceId), eq(credentialAccessEvents.credentialId, credentialId)))
    .orderBy(desc(credentialAccessEvents.id))
    .limit(limit);
}

/** The Workspace's audit log, for removing someone else's credential. */
export async function insertAudit(tx: WorkspaceTx, e: typeof workspaceAudit.$inferInsert) {
  await tx.insert(workspaceAudit).values(e);
}

/** The Organization a Workspace belongs to, or null for a Workspace that isn't there. */
export async function workspaceOrg(tx: WorkspaceTx, workspaceId: string): Promise<string | null> {
  const [row] = await tx.select({ orgId: workspaces.orgId }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return row?.orgId ?? null;
}

/** Creates the system Workspace if it is not there yet. Safe when two processes start at once. */
export async function ensureSystemWorkspaceRows(tx: WorkspaceTx, workspaceId: string, orgId: string, at: Date) {
  await tx.insert(organizations).values({ id: orgId, name: "Direx system", createdAt: at }).onConflictDoNothing();
  await tx.insert(workspaces).values({ id: workspaceId, orgId, name: "Direx system", createdAt: at }).onConflictDoNothing();
}
