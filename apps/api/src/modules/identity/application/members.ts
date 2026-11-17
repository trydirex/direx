// SPDX-License-Identifier: AGPL-3.0-only
// Role changes, removals and Workspace deletion. Each runs under the Workspace row lock and
// re-reads the actor's role, so two changes at once cannot both pass the last-Owner check.
import * as repo from "../adapters/repo";
import { can, checkMembershipChange, type MembershipRefusal, type Role } from "../domain/roles";
import type { Member } from "../middleware";

export type MemberRefusal = MembershipRefusal | "not_member";

export const listMembers = (workspaceId: string) => repo.inWorkspace(workspaceId, repo.listMembers);

async function change(m: Member, userId: string, to: Role | null, now: Date): Promise<MemberRefusal | null> {
  return repo.inWorkspace(m.workspaceId, async (tx) => {
    await repo.lockWorkspace(tx);
    const actor = await repo.findMember(tx, m.userId);
    const target = await repo.findMember(tx, userId);
    if (!actor) return "forbidden";
    if (!target) return "not_member";
    if (to === target.role) return null;
    const refused = checkMembershipChange({ actor: actor.role, from: target.role, to, owners: await repo.ownerCount(tx) });
    if (refused) return refused;
    const e = { subjectUserId: userId, fromRole: target.role, stepUp: true, actorUserId: m.userId };
    if (to) await repo.setRole(tx, m.workspaceId, userId, to, { ...e, event: "member.role_changed", toRole: to }, now);
    else await repo.removeMember(tx, m.workspaceId, userId, { ...e, event: "member.removed" }, now);
    return null;
  });
}

export const changeRole = (m: Member, userId: string, to: Role, now = new Date()) => change(m, userId, to, now);
export const removeMember = (m: Member, userId: string, now = new Date()) => change(m, userId, null, now);

/** What else ends with the Workspace, in the deleting transaction: the ledger cancels its open Actions. */
export type OnDelete = (tx: repo.WorkspaceTx) => Promise<unknown>;

export function deleteWorkspace(m: Member, onDelete?: OnDelete): Promise<"forbidden" | null> {
  return repo.inWorkspace(m.workspaceId, async (tx) => {
    await repo.lockWorkspace(tx);
    const actor = await repo.findMember(tx, m.userId);
    if (!actor || !can(actor.role, "workspace.delete")) return "forbidden";
    await repo.softDeleteWorkspace(tx, m.workspaceId, m.userId);
    await onDelete?.(tx);
    return null;
  });
}

export const auditLog = (workspaceId: string, limit = 100) => repo.inWorkspace(workspaceId, (tx) => repo.auditLog(tx, limit));
