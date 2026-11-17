// SPDX-License-Identifier: AGPL-3.0-only
// The ledger check that an approval still stands for its approver: run at claim and again
// at dispatch, it reads the approver's role now, not when they approved.
import { approverIdFromSession, type ApproverId, type Check } from "../../ledger";
import { isDeleted, roleIn } from "../adapters/repo";
import { can, type Permission } from "../domain/roles";

/**
 * Holds an Action whose approver no longer holds the permission its approval needed, or left the
 * Workspace. That is item.approve unless `permissionFor` names another for the capability: a Mailbox
 * check needs only credential.connect, since whoever connected the Mailbox approves it.
 */
export const approverMayApprove = (permissionFor: (capability: string) => Permission | undefined = () => undefined): Check => async (tx, action, approval) => {
  const role = await roleIn(tx, approval.approverId);
  return role && can(role, permissionFor(action.capability) ?? "item.approve")
    ? { kind: "ok" }
    : { kind: "hold", reason: "approver_permission_lost", detail: role ? `approver is now ${role}` : "approver left the Workspace" };
};

/** Whether this user may still create standing rules, read now. A rule's granter must keep this. */
export const mayGrantRules = async (tx: Parameters<typeof roleIn>[0], userId: string): Promise<boolean> => {
  const role = await roleIn(tx, userId);
  return !!role && can(role, "rule.grant");
};

/**
 * Nothing goes out for a Workspace its Owner deleted, whatever was approved before. The dispatcher blocks
 * such an Action before this runs; this catches a delete that lands between its read and its lock.
 */
export const workspaceLive = (): Check => async (tx, action) =>
  (await isDeleted(tx, action.workspaceId)) ? { kind: "block", reason: "workspace_deleted" } : { kind: "ok" };

/** The approver is always the signed-in member, never a user id from a request. */
export const approverFromMember = (member: { userId: string }): ApproverId => approverIdFromSession(member.userId);
