// SPDX-License-Identifier: AGPL-3.0-only
// Queries on the identity tables. withUser only lists a user's Workspaces; everything
// else runs in withWorkspace.
import { withWorkspace, WorkspacePurging, type WorkspaceTx } from "@direx/db";
import { authSchema } from "@direx/db/auth";
import { organizations, workspaceAudit, workspaceInvites, workspaceMembers, workspaces } from "@direx/db/schema";
import { withUser } from "@direx/db/user";
import { and, count, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Role } from "../domain/roles";

export { WorkspacePurging };

export type MyWorkspace = { id: string; name: string; role: Role; organization: { id: string; name: string } };

/** Creates an Organization, its first Workspace and the Owner in one transaction. */
export async function insertOrganization(a: { userId: string; orgName: string; workspaceName: string; now: Date }) {
  const orgId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  // No RETURNING on the Organization: it becomes readable only once its Workspace exists.
  await withWorkspace(workspaceId, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name: a.orgName, createdAt: a.now });
    await tx.insert(workspaces).values({ id: workspaceId, orgId, name: a.workspaceName, createdAt: a.now });
    await tx.insert(workspaceMembers).values({ workspaceId, userId: a.userId, role: "owner", createdAt: a.now });
    await tx.insert(workspaceAudit).values({
      workspaceId,
      event: "workspace.created",
      subjectUserId: a.userId,
      toRole: "owner",
      actorUserId: a.userId,
      at: a.now,
    });
  });
  return { orgId, workspaceId };
}

export function listMyWorkspaces(userId: string): Promise<MyWorkspace[]> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role, orgId: organizations.id, orgName: organizations.name })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.workspaceId, workspaceMembers.workspaceId))
      .innerJoin(organizations, eq(organizations.id, workspaces.orgId))
      .where(and(eq(workspaceMembers.userId, userId), isNull(workspaces.deletedAt)))
      .orderBy(workspaces.name);
    return rows.map((r) => ({ id: r.id, name: r.name, role: r.role as Role, organization: { id: r.orgId, name: r.orgName } }));
  });
}

export type DeletedWorkspace = { id: string; name: string; organization: { id: string; name: string }; deletedAt: Date };

/**
 * Deleted Workspaces the user is an Owner of that no purge has started on, oldest deletion first: their
 * export stays open to Owners until the purge (ADR 0030 rule 008), and nothing else of them does.
 */
export function listDeletedWorkspaces(userId: string): Promise<DeletedWorkspace[]> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select({ id: workspaces.id, name: workspaces.name, orgId: organizations.id, orgName: organizations.name, deletedAt: workspaces.deletedAt })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.workspaceId, workspaceMembers.workspaceId))
      .innerJoin(organizations, eq(organizations.id, workspaces.orgId))
      .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.role, "owner"), isNotNull(workspaces.deletedAt), isNull(workspaces.purgingAt)))
      .orderBy(workspaces.deletedAt);
    return rows.map((r) => ({ id: r.id, name: r.name, organization: { id: r.orgId, name: r.orgName }, deletedAt: r.deletedAt! }));
  });
}

/**
 * The user's role in a live Workspace, or null when they are not a member or it is gone. `deleted`
 * also finds a deleted Workspace that is not yet purged, for its export (ADR 0030 rule 008).
 */
export function memberRole(workspaceId: string, userId: string, deleted = false): Promise<{ role: Role; workspaceName: string } | null> {
  return withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx
      .select({ role: workspaceMembers.role, workspaceName: workspaces.name })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.workspaceId, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, userId), deleted ? undefined : isNull(workspaces.deletedAt)));
    return row ? { role: row.role as Role, workspaceName: row.workspaceName } : null;
  }).catch((e: unknown) => {
    // A Workspace being purged is gone to every request, its export routes included (ADR 0030 rule 007).
    if (e instanceof WorkspacePurging) return null;
    throw e;
  });
}

/** memberRole inside a transaction the caller already holds for that Workspace. */
export async function roleIn(tx: WorkspaceTx, userId: string): Promise<Role | null> {
  const [row] = await tx
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.workspaceId, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, userId), isNull(workspaces.deletedAt)));
  return (row?.role as Role | undefined) ?? null;
}

export type AuditEvent = {
  event: string;
  subjectUserId?: string;
  subjectEmail?: string;
  fromRole?: Role;
  toRole?: Role;
  stepUp?: boolean;
  actorUserId: string;
};

const audit = (tx: WorkspaceTx, workspaceId: string, e: AuditEvent, at: Date) =>
  tx.insert(workspaceAudit).values({ workspaceId, at, ...e });

export const inWorkspace = withWorkspace;
export type { WorkspaceTx };

export async function listMembers(tx: WorkspaceTx) {
  const rows = await tx
    .select({
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      email: authSchema.user.email,
      name: authSchema.user.name,
      createdAt: workspaceMembers.createdAt,
    })
    .from(workspaceMembers)
    .innerJoin(authSchema.user, eq(authSchema.user.id, workspaceMembers.userId))
    .orderBy(workspaceMembers.createdAt);
  return rows.map((r) => ({ ...r, role: r.role as Role }));
}

/** Whether a Workspace was deleted. A row RLS hides or that never existed isn't deleted. */
export async function isDeleted(tx: WorkspaceTx, workspaceId: string): Promise<boolean> {
  const [row] = await tx.select({ deletedAt: workspaces.deletedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return !!row?.deletedAt;
}

export async function findMember(tx: WorkspaceTx, userId: string) {
  const [row] = await tx.select().from(workspaceMembers).where(eq(workspaceMembers.userId, userId)).for("update");
  return row ? { ...row, role: row.role as Role } : null;
}

export async function ownerCount(tx: WorkspaceTx) {
  const [row] = await tx.select({ n: count() }).from(workspaceMembers).where(eq(workspaceMembers.role, "owner"));
  return row!.n;
}

/** Takes the Workspace row lock, so two concurrent role changes cannot both pass the last-Owner check. */
export async function lockWorkspace(tx: WorkspaceTx): Promise<{ deleted: boolean } | null> {
  const [row] = await tx.select({ deletedAt: workspaces.deletedAt }).from(workspaces).for("update");
  return row ? { deleted: row.deletedAt !== null } : null;
}

export async function setRole(tx: WorkspaceTx, workspaceId: string, userId: string, role: Role, e: AuditEvent, at: Date) {
  await tx.update(workspaceMembers).set({ role }).where(eq(workspaceMembers.userId, userId));
  await audit(tx, workspaceId, e, at);
}

export async function removeMember(tx: WorkspaceTx, workspaceId: string, userId: string, e: AuditEvent, at: Date) {
  await tx.delete(workspaceMembers).where(eq(workspaceMembers.userId, userId));
  await audit(tx, workspaceId, e, at);
}

export async function addMember(tx: WorkspaceTx, workspaceId: string, userId: string, role: Role, e: AuditEvent, at: Date) {
  await tx.insert(workspaceMembers).values({ workspaceId, userId, role, createdAt: at });
  await audit(tx, workspaceId, e, at);
}

export async function insertInvite(
  tx: WorkspaceTx,
  i: { workspaceId: string; email: string; role: Role; tokenHash: string; invitedBy: string; expiresAt: Date },
  at: Date,
) {
  const [row] = await tx
    .insert(workspaceInvites)
    .values({ ...i, createdAt: at })
    .returning({ id: workspaceInvites.id });
  await audit(tx, i.workspaceId, { event: "invite.created", subjectEmail: i.email, toRole: i.role, actorUserId: i.invitedBy }, at);
  return row!.id;
}

/** Gives a pending invite a new link, role and expiry; the old link stops working. */
export async function refreshInvite(
  tx: WorkspaceTx,
  id: string,
  i: { workspaceId: string; email: string; role: Role; tokenHash: string; invitedBy: string; expiresAt: Date },
  at: Date,
) {
  await tx
    .update(workspaceInvites)
    .set({ role: i.role, tokenHash: i.tokenHash, invitedBy: i.invitedBy, expiresAt: i.expiresAt })
    .where(eq(workspaceInvites.id, id));
  await audit(tx, i.workspaceId, { event: "invite.resent", subjectEmail: i.email, toRole: i.role, actorUserId: i.invitedBy }, at);
}

export function pendingInvites(tx: WorkspaceTx) {
  return tx
    .select({ id: workspaceInvites.id, email: workspaceInvites.email, role: workspaceInvites.role, expiresAt: workspaceInvites.expiresAt })
    .from(workspaceInvites)
    .where(and(isNull(workspaceInvites.acceptedAt), isNull(workspaceInvites.revokedAt)))
    .orderBy(workspaceInvites.createdAt);
}

export async function inviteBy(tx: WorkspaceTx, where: { id: string } | { tokenHash: string }) {
  const cond = "id" in where ? eq(workspaceInvites.id, where.id) : eq(workspaceInvites.tokenHash, where.tokenHash);
  const [row] = await tx.select().from(workspaceInvites).where(cond).for("update");
  return row ? { ...row, role: row.role as Role } : null;
}

/** The Workspace's name, or null when it is empty or the Workspace can't be read. */
export async function workspaceName(tx: WorkspaceTx): Promise<string | null> {
  const [w] = await tx.select({ name: workspaces.name }).from(workspaces);
  return w?.name || null;
}

/** What an invite page names: the Workspace, and whoever sent the invite (their name, else their email). */
export async function inviteNames(tx: WorkspaceTx, invitedBy: string) {
  const [w] = await tx.select({ name: workspaces.name }).from(workspaces);
  const [u] = await tx.select({ name: authSchema.user.name, email: authSchema.user.email }).from(authSchema.user).where(eq(authSchema.user.id, invitedBy));
  return { workspaceName: w?.name ?? "", invitedBy: u?.name || u?.email || "" };
}

export async function markInvite(tx: WorkspaceTx, workspaceId: string, id: string, field: "acceptedAt" | "revokedAt", e: AuditEvent, at: Date) {
  await tx.update(workspaceInvites).set({ [field]: at }).where(eq(workspaceInvites.id, id));
  await audit(tx, workspaceId, e, at);
}

export function auditLog(tx: WorkspaceTx, limit: number) {
  return tx.select().from(workspaceAudit).orderBy(desc(workspaceAudit.at), desc(workspaceAudit.id)).limit(limit);
}

/**
 * Stamps deleted_at with the database's clock, writes the workspace.deleted audit event and cancels the
 * Workspace's queued jobs, all in system.soft_delete_workspace (ADR 0030 rule 003): the app can't write
 * deleted_at itself.
 */
export async function softDeleteWorkspace(tx: WorkspaceTx, workspaceId: string, actorUserId: string): Promise<void> {
  await tx.execute(sql`select system.soft_delete_workspace(${workspaceId}::uuid, ${actorUserId}::uuid)`);
}
