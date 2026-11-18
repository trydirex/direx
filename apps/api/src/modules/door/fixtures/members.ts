// SPDX-License-Identifier: AGPL-3.0-only
// Test support for External tokens: a Workspace with members whose roles a test can change, and the
// audit rows a token left.
import { withWorkspace, type WorkspaceTx } from "@direx/db";
import { authDb, authSchema } from "@direx/db/auth";
import { workspaceAudit, workspaceMembers } from "@direx/db/schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { seedMember } from "../../identity/fixtures/member";
import type { Role } from "../../identity/index";

/** A new Workspace whose Owner is `owner`. */
export const seedWorkspace = (workspaceId: string, owner: string) => seedMember(workspaceId, owner, "owner");

/** Adds, changes or (with null) removes a member, as a test would by hand. */
export async function setRole(workspaceId: string, userId: string, role: Role | null) {
  await authDb().insert(authSchema.user).values({ id: userId, name: "Test", email: `${userId}@example.com` }).onConflictDoNothing();
  await withWorkspace(workspaceId, async (tx) => {
    await tx.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
    if (role) await tx.insert(workspaceMembers).values({ workspaceId, userId, role, createdAt: new Date() });
  });
}

/** Deletes the Workspace as its Owner would, leaving it restorable until purge. */
export const softDeleteWorkspace = (workspaceId: string, by: string) =>
  withWorkspace(workspaceId, (tx) => tx.execute(sql`select system.soft_delete_workspace(${workspaceId}::uuid, ${by}::uuid)`));

export const tokenAudit = (workspaceId: string) =>
  withWorkspace(workspaceId, (tx) =>
    tx
      .select({ event: workspaceAudit.event, tokenId: workspaceAudit.subjectTokenId, actor: workspaceAudit.actorUserId, stepUp: workspaceAudit.stepUp })
      .from(workspaceAudit)
      .where(isNotNull(workspaceAudit.subjectTokenId))
      .orderBy(workspaceAudit.id),
  );

/** One Item waiting for a person, for a proposal record to point at. */
export async function seedItem(workspaceId: string): Promise<string> {
  const r = await withWorkspace(workspaceId, (tx) =>
    tx.execute(sql`insert into items (workspace_id, kind, state, title, warnings, created_at, updated_at) values (${workspaceId}, 'plan_change', 'needs_approval', 't', '[]', now(), now()) returning id`),
  );
  return (r.rows[0] as { id: string }).id;
}

/** An owner write in the proposal transaction, including its rollback. */
export async function seedItemIn(tx: WorkspaceTx, workspaceId: string): Promise<string> {
  const r = await tx.execute(sql`insert into items (workspace_id, kind, state, title, warnings, created_at, updated_at) values (${workspaceId}, 'plan_change', 'needs_approval', 't', '[]', now(), now()) returning id`);
  return (r.rows[0] as { id: string }).id;
}

/** Count owner Items after a failed proposal transaction. */
export const proposalItemCount = (workspaceId: string) => withWorkspace(workspaceId, async (tx) => {
  const r = await tx.execute(sql`select count(*)::int as n from items`);
  return (r.rows[0] as { n: number }).n;
});
