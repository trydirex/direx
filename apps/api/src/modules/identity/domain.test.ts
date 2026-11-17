// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { checkAccept, hashInviteToken, INVITE_TTL_MS, newInviteToken } from "./domain/invite";
import { can, checkInvite, checkMembershipChange, ROLES, type Permission, type Role } from "./domain/roles";

const TABLE: Record<Permission, Role[]> = {
  "workspace.read": ["owner", "admin", "marketer", "contributor", "viewer"],
  "item.edit": ["owner", "admin", "marketer", "contributor"],
  "item.approve": ["owner", "admin", "marketer"],
  "workspace.members": ["owner", "admin"],
  "workspace.settings": ["owner", "admin"],
  "workspace.delete": ["owner"],
  "workspace.export": ["owner"],
  "credential.connect": ["owner", "admin", "marketer", "contributor"],
  "credential.manage": ["owner", "admin"],
  "rule.grant": ["owner", "admin"],
  "outreach.undo_optout": ["owner"],
  "campaign.delete_draft": ["owner", "admin"],
  "plugin.turn_on": ["owner"],
};

test("every cell of the role table", () => {
  for (const [p, allowed] of Object.entries(TABLE) as [Permission, Role[]][])
    for (const r of ROLES) expect(can(r, p), `${r} ${p}`).toBe(allowed.includes(r));
});

test("membership changes: forbidden, Admin and Owners, last Owner", () => {
  expect(checkMembershipChange({ actor: "marketer", from: "viewer", to: "contributor", owners: 1 })).toBe("forbidden");
  expect(checkMembershipChange({ actor: "admin", from: "viewer", to: "marketer", owners: 1 })).toBeNull();
  expect(checkMembershipChange({ actor: "admin", from: "viewer", to: "owner", owners: 1 })).toBe("admin_cannot_manage_owner");
  expect(checkMembershipChange({ actor: "admin", from: "owner", to: "admin", owners: 2 })).toBe("admin_cannot_manage_owner");
  expect(checkMembershipChange({ actor: "admin", from: "owner", to: null, owners: 2 })).toBe("admin_cannot_manage_owner");
  expect(checkMembershipChange({ actor: "owner", from: "owner", to: "admin", owners: 1 })).toBe("last_owner");
  expect(checkMembershipChange({ actor: "owner", from: "owner", to: null, owners: 1 })).toBe("last_owner");
  expect(checkMembershipChange({ actor: "owner", from: "owner", to: null, owners: 2 })).toBeNull();
  expect(checkMembershipChange({ actor: "owner", from: "admin", to: "owner", owners: 1 })).toBeNull();
});

test("invites: who may invite which role", () => {
  expect(checkInvite("contributor", "viewer")).toBe("forbidden");
  expect(checkInvite("admin", "marketer")).toBeNull();
  expect(checkInvite("admin", "owner")).toBe("admin_cannot_manage_owner");
  expect(checkInvite("owner", "owner")).toBeNull();
});

test("accepting an invite: once, unrevoked, unexpired, same email in any case", () => {
  const now = new Date("2026-10-29T12:00:00Z");
  const invite = { email: "Dana@Example.com", expiresAt: new Date(now.getTime() + INVITE_TTL_MS), acceptedAt: null, revokedAt: null };
  expect(checkAccept(invite, " dana@example.COM ", now)).toBeNull();
  expect(checkAccept(invite, "sam@example.com", now)).toBe("wrong_email");
  expect(checkAccept({ ...invite, acceptedAt: now }, "dana@example.com", now)).toBe("accepted");
  expect(checkAccept({ ...invite, revokedAt: now }, "dana@example.com", now)).toBe("revoked");
  expect(checkAccept(invite, "dana@example.com", invite.expiresAt)).toBe("expired");
});

test("invite tokens are 32 random bytes and hash to a stable SHA-256", async () => {
  const t = newInviteToken();
  expect(t).toMatch(/^[0-9a-f]{64}$/);
  expect(newInviteToken()).not.toBe(t);
  expect(await hashInviteToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
