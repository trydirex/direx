// SPDX-License-Identifier: AGPL-3.0-only
// Test support for External tokens: a Workspace with members whose roles a test can change, and the
// audit rows a token left.
import { withWorkspace } from "@direx/db";
import { authDb, authSchema } from "@direx/db/auth";
import { workspaceAudit, workspaceMembers } from "@direx/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";
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

export const tokenAudit = (workspaceId: string) =>
  withWorkspace(workspaceId, (tx) =>
    tx
      .select({ event: workspaceAudit.event, tokenId: workspaceAudit.subjectTokenId, actor: workspaceAudit.actorUserId, stepUp: workspaceAudit.stepUp })
      .from(workspaceAudit)
      .where(isNotNull(workspaceAudit.subjectTokenId))
      .orderBy(workspaceAudit.id),
  );
