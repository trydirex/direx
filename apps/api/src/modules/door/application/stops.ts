// SPDX-License-Identifier: AGPL-3.0-only
// A token stops when its creator stops being an Owner or Admin (ADR 0032 Q9); verify reads that on
// every call. This records the moment: one audit row per live token, and one email to the Owners and
// Admins left, naming them. identity calls it after a role change or removal commits, through a
// function handed in where it is built, since identity can't import this module.
import { can, named, workspaceName, type Mailer, type Role } from "../../identity/index";
import * as repo from "../adapters/repo";

export type Stopped = (workspaceId: string, userId: string, from: Role, to: Role | null) => Promise<void>;

const holds = (role: Role | null) => role !== null && can(role, "workspace.settings");

function notice(names: readonly string[]) {
  const listed = names.map((n) => JSON.stringify(n)).join(", ");
  const one = names.length === 1;
  return {
    subject: one ? "An External token stopped working" : `${names.length} External tokens stopped working`,
    text:
      `${one ? "This External token" : "These External tokens"} stopped working because the person who made ${one ? "it" : "them"} is no longer an Owner or Admin of this Workspace: ${listed}.\n\n` +
      `Anything that used ${one ? "it" : "them"} can't reach the Workspace now. To keep it working, an Owner or Admin can make a new token in Settings, under External tokens. If that person gets the role back, ${one ? "the token works" : "the tokens work"} again.`,
  };
}

export function createStops(d: { mailer: Mailer; adminEmails: (workspaceId: string) => Promise<string[]>; now?: () => Date }): Stopped {
  const now = d.now ?? (() => new Date());
  return async (workspaceId, userId, from, to) => {
    if (!holds(from) || holds(to)) return;
    const live = await repo.inWorkspace(workspaceId, (tx) => repo.recordStops(tx, workspaceId, userId, now()));
    if (!live.length) return;
    const mail = named(await workspaceName(workspaceId))(notice(live.map((t) => t.name)));
    for (const address of await d.adminEmails(workspaceId)) await d.mailer({ to: address, ...mail });
  };
}
