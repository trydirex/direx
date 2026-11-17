// SPDX-License-Identifier: AGPL-3.0-only
// Test support for installed plugins: Workspaces, and a Workspace owner's turn-on written as the
// Capabilities page will write it.
import { withWorkspace } from "@direx/db";
import { organizations, workspacePlugins, workspaces } from "@direx/db/schema";

export async function newWorkspace(): Promise<string> {
  const id = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  await withWorkspace(id, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name: "Org", createdAt: new Date() });
    await tx.insert(workspaces).values({ id, orgId, name: "W", createdAt: new Date() });
  });
  return id;
}

export const turnOnPlugin = (workspaceId: string, row: { pluginId: string; installId: string; permissionHash: string; by: string }) =>
  withWorkspace(workspaceId, (tx) =>
    tx.insert(workspacePlugins).values({ workspaceId, pluginId: row.pluginId, installId: row.installId, permissionHash: row.permissionHash, enabledBy: row.by, enabledAt: new Date() }),
  );

export const turnOffPlugins = (workspaceId: string) => withWorkspace(workspaceId, (tx) => tx.delete(workspacePlugins));
