// SPDX-License-Identifier: AGPL-3.0-only
import { insertOrganization, listDeletedWorkspaces, listMyWorkspaces } from "../adapters/repo";

export { listDeletedWorkspaces, listMyWorkspaces };

/** Any signed-in user may create an Organization; they become Owner of its first Workspace. */
export async function createOrganization(userId: string, names: { orgName: string; workspaceName: string }, now = new Date()) {
  const { orgId, workspaceId } = await insertOrganization({ userId, ...names, now });
  return {
    organization: { id: orgId, name: names.orgName },
    workspace: { id: workspaceId, name: names.workspaceName, role: "owner" as const },
  };
}
