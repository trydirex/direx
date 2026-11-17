// SPDX-License-Identifier: AGPL-3.0-only
// Test support for the approver check: a membership for Actions approved in a test
// Workspace, and the ledger's test helpers.
import { withWorkspace } from "@direx/db";
import { authDb, authSchema } from "@direx/db/auth";
import { organizations, workspaceMembers, workspaces } from "@direx/db/schema";
import type { Role } from "../domain/roles";

export { fakeEffect, testLedger } from "../../ledger/test-effects";

/** Makes `userId` a member of a new live Workspace with id `workspaceId`. */
export async function seedMember(workspaceId: string, userId: string, role: Role = "owner") {
  const now = new Date();
  await authDb()
    .insert(authSchema.user)
    .values({ id: userId, name: "Test", email: `${userId}@example.com` })
    .onConflictDoNothing();
  const orgId = crypto.randomUUID();
  await withWorkspace(workspaceId, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name: "Test", createdAt: now });
    await tx.insert(workspaces).values({ id: workspaceId, orgId, name: "Test", createdAt: now });
    await tx.insert(workspaceMembers).values({ workspaceId, userId, role, createdAt: now });
  });
}
