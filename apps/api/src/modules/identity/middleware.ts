// SPDX-License-Identifier: AGPL-3.0-only
// The request context for /api/w/:workspaceId/*: who is asking, in which Workspace, with
// which role. A Workspace the caller is not a member of is 404, so its existence does not leak.
import { createMiddleware } from "hono/factory";
import type { Auth } from "./adapters/auth";
import { memberRole } from "./adapters/repo";
import { can, type Permission, type Role } from "./domain/roles";

export type Member = {
  userId: string;
  email: string;
  workspaceId: string;
  workspaceName: string;
  role: Role;
  /** When this session signed in; step-up compares it to now. */
  signedInAt: Date;
};
export type MemberEnv = { Variables: { member: Member } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `deleted: true` lets a deleted Workspace through until its purge; only its export routes ask for that. */
export function requireMember(auth: () => Auth, o: { deleted?: boolean } = {}) {
  return createMiddleware<MemberEnv>(async (c, next) => {
    // A Workspace route takes a session only. Sessions are cookies, so any Authorization header is a
    // credential meant for somewhere else, an External token included (ADR 0032 rule 002).
    if (c.req.header("authorization") !== undefined) return c.json({ error: "token_not_accepted" }, 401);
    const s = await auth().api.getSession({ headers: c.req.raw.headers });
    if (!s) return c.json({ error: "not_signed_in" }, 401);
    const workspaceId = c.req.param("workspaceId");
    const found = workspaceId && UUID.test(workspaceId) ? await memberRole(workspaceId, s.user.id, o.deleted) : null;
    if (!found) return c.json({ error: "not_found" }, 404);
    c.set("member", {
      userId: s.user.id,
      email: s.user.email,
      workspaceId: workspaceId!,
      workspaceName: found.workspaceName,
      role: found.role,
      signedInAt: new Date(s.session.createdAt),
    });
    await next();
  });
}

export function requirePermission(p: Permission) {
  return createMiddleware<MemberEnv>(async (c, next) => {
    if (!can(c.get("member").role, p)) return c.json({ error: "forbidden" }, 403);
    await next();
  });
}

/** Step-up: elevated actions need a sign-in in the last 10 minutes. */
export const STEP_UP_MS = 10 * 60_000;

/** For routes whose step-up depends on what the request touches. */
export const steppedUp = (m: Member, now = new Date()) => now.getTime() - m.signedInAt.getTime() <= STEP_UP_MS;

export function requireStepUp(now: () => Date = () => new Date()) {
  return createMiddleware<MemberEnv>(async (c, next) => {
    if (!steppedUp(c.get("member"), now())) return c.json({ error: "step_up_required" }, 403);
    await next();
  });
}
