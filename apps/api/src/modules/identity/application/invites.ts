// SPDX-License-Identifier: AGPL-3.0-only
// Invites tied to one email. The link names the Workspace, so accepting runs in that
// Workspace's own transaction; the token is stored only as a hash.
import * as repo from "../adapters/repo";
import type { Mailer } from "../adapters/mail";
import { checkAccept, hashInviteToken, INVITE_TTL_MS, newInviteToken, normalizeEmail, type InviteRefusal } from "../domain/invite";
import { checkInvite, type MembershipRefusal, type Role } from "../domain/roles";
import type { Member } from "../middleware";

export type InviteDeps = { mailer: Mailer; baseURL: string };

export const listInvites = (workspaceId: string) => repo.inWorkspace(workspaceId, repo.pendingInvites);

export async function createInvite(
  m: Member,
  input: { email: string; role: Role },
  deps: InviteDeps,
  now = new Date(),
): Promise<
  { ok: true; resent: boolean; invite: { id: string; email: string; role: Role; expiresAt: Date } } | { ok: false; reason: MembershipRefusal | "already_member" }
> {
  const email = normalizeEmail(input.email);
  const token = newInviteToken();
  const tokenHash = await hashInviteToken(token);
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  const result = await repo.inWorkspace(m.workspaceId, async (tx) => {
    const actor = await repo.findMember(tx, m.userId);
    const refused = actor ? checkInvite(actor.role, input.role) : "forbidden";
    if (refused) return { ok: false as const, reason: refused };
    if ((await repo.listMembers(tx)).some((x) => normalizeEmail(x.email) === email))
      return { ok: false as const, reason: "already_member" as const };
    // One pending invite per email: inviting again sends a fresh link on the same invite.
    // The Workspace lock makes two invites sent at once queue here instead of both inserting.
    await repo.lockWorkspace(tx);
    const fields = { workspaceId: m.workspaceId, email, role: input.role, tokenHash, invitedBy: m.userId, expiresAt };
    const pending = (await repo.pendingInvites(tx)).find((i) => i.email === email);
    if (pending) await repo.refreshInvite(tx, pending.id, fields, now);
    const id = pending?.id ?? (await repo.insertInvite(tx, fields, now));
    return { ok: true as const, resent: !!pending, invite: { id, email, role: input.role, expiresAt } };
  });
  if (result.ok) {
    const link = `${deps.baseURL}/invite/${m.workspaceId}/${token}`;
    await deps.mailer({
      to: email,
      subject: `You're invited to ${m.workspaceName} on Direx`,
      text: `${m.email} invited you to ${m.workspaceName} on Direx as ${input.role}.\n\nAccept: ${link}\n\nThe link works once, for ${email} only, and expires in 7 days.`,
    });
  }
  return result;
}

export function revokeInvite(m: Member, id: string, now = new Date()): Promise<"not_found" | null> {
  return repo.inWorkspace(m.workspaceId, async (tx) => {
    const invite = await repo.inviteBy(tx, { id });
    if (!invite || invite.acceptedAt || invite.revokedAt) return "not_found";
    await repo.markInvite(tx, m.workspaceId, id, "revokedAt", { event: "invite.revoked", subjectEmail: invite.email, actorUserId: m.userId }, now);
    return null;
  });
}

export type AcceptRefusal = InviteRefusal | "not_found" | "unverified_email" | "already_member";

export async function acceptInvite(
  user: { id: string; email: string; emailVerified: boolean },
  workspaceId: string,
  token: string,
  now = new Date(),
): Promise<{ ok: true; role: Role } | { ok: false; reason: AcceptRefusal }> {
  const tokenHash = await hashInviteToken(token);
  return repo.inWorkspace(workspaceId, async (tx) => {
    const ws = await repo.lockWorkspace(tx);
    const invite = ws && !ws.deleted ? await repo.inviteBy(tx, { tokenHash }) : null;
    if (!invite) return { ok: false as const, reason: "not_found" as const };
    if (!user.emailVerified) return { ok: false as const, reason: "unverified_email" as const };
    const refused = checkAccept(invite, user.email, now);
    if (refused) return { ok: false as const, reason: refused };
    if (await repo.findMember(tx, user.id)) return { ok: false as const, reason: "already_member" as const };
    const e = { subjectUserId: user.id, subjectEmail: invite.email, toRole: invite.role, actorUserId: user.id };
    await repo.addMember(tx, workspaceId, user.id, invite.role, { ...e, event: "member.added" }, now);
    await repo.markInvite(tx, workspaceId, invite.id, "acceptedAt", { ...e, event: "invite.accepted" }, now);
    return { ok: true as const, role: invite.role };
  });
}

/**
 * What the invite page shows before Accept: the Workspace and who invited you, or the refusal
 * accepting would give now. Only the token's holder gets an answer; it writes nothing.
 */
export async function previewInvite(
  user: { email: string },
  workspaceId: string,
  token: string,
  now = new Date(),
): Promise<{ ok: true; workspaceName: string; invitedBy: string } | { ok: false; reason: InviteRefusal | "not_found" }> {
  const tokenHash = await hashInviteToken(token);
  return repo.inWorkspace(workspaceId, async (tx) => {
    const ws = await repo.lockWorkspace(tx);
    const invite = ws && !ws.deleted ? await repo.inviteBy(tx, { tokenHash }) : null;
    if (!invite) return { ok: false as const, reason: "not_found" as const };
    const refused = checkAccept(invite, user.email, now);
    if (refused) return { ok: false as const, reason: refused };
    return { ok: true as const, ...(await repo.inviteNames(tx, invite.invitedBy)) };
  });
}
