// SPDX-License-Identifier: AGPL-3.0-only
// The five preset roles and what each may do in a Workspace. Later modules add
// permissions to GRANTS; they never add roles.

export const ROLES = ["owner", "admin", "marketer", "contributor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

const GRANTS = {
  "workspace.read": ["owner", "admin", "marketer", "contributor", "viewer"],
  "item.edit": ["owner", "admin", "marketer", "contributor"],
  "item.approve": ["owner", "admin", "marketer"],
  "workspace.members": ["owner", "admin"],
  "workspace.settings": ["owner", "admin"],
  "workspace.delete": ["owner"],
  /** Download everything the Workspace holds, until it is purged (ADR 0030 rule 008). */
  "workspace.export": ["owner"],
  /** Connect a mailbox; create or rotate your own user secret. */
  "credential.connect": ["owner", "admin", "marketer", "contributor"],
  /** Workspace secrets, and anyone's user credential. */
  "credential.manage": ["owner", "admin"],
  /** Can create standing rules. */
  "rule.grant": ["owner", "admin"],
  /** Undo an opt-out read from a reply, which lets mail reach someone who may have said stop. */
  "outreach.undo_optout": ["owner"],
  /** Delete anyone's Draft Campaign for good (ADR 0023); its creator may always delete their own. */
  "campaign.delete_draft": ["owner", "admin"],
  /** Turn a third-party plugin a Server admin installed on or off in this Workspace (ADR 0026 rule 002). */
  "plugin.turn_on": ["owner"],
} satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof GRANTS;

export const can = (role: Role, p: Permission): boolean => (GRANTS[p] as readonly Role[]).includes(role);

export type MembershipRefusal = "forbidden" | "admin_cannot_manage_owner" | "last_owner";

/**
 * Whether `actor` may move a member from `from` to `to` (null `to` removes them).
 * `owners` is the Workspace's Owner count before the change.
 */
export function checkMembershipChange(a: {
  actor: Role;
  from: Role;
  to: Role | null;
  owners: number;
}): MembershipRefusal | null {
  if (!can(a.actor, "workspace.members")) return "forbidden";
  if (a.actor !== "owner" && (a.from === "owner" || a.to === "owner")) return "admin_cannot_manage_owner";
  if (a.from === "owner" && a.to !== "owner" && a.owners <= 1) return "last_owner";
  return null;
}

/** Whether `actor` may invite someone with `role`. */
export function checkInvite(actor: Role, role: Role): MembershipRefusal | null {
  if (!can(actor, "workspace.members")) return "forbidden";
  if (actor !== "owner" && role === "owner") return "admin_cannot_manage_owner";
  return null;
}
