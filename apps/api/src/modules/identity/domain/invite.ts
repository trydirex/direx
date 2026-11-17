// SPDX-License-Identifier: AGPL-3.0-only
// Invite tokens: 32 random bytes shown once in the link, stored only as a SHA-256 hash.

export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

export type InviteRow = { email: string; expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null };
export type InviteRefusal = "accepted" | "revoked" | "expired" | "wrong_email";

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function newInviteToken(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashInviteToken(token: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))));
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Whether a session with this verified email may accept the invite now. */
export function checkAccept(invite: InviteRow, sessionEmail: string, now: Date): InviteRefusal | null {
  if (invite.acceptedAt) return "accepted";
  if (invite.revokedAt) return "revoked";
  if (now >= invite.expiresAt) return "expired";
  if (normalizeEmail(sessionEmail) !== normalizeEmail(invite.email)) return "wrong_email";
  return null;
}
