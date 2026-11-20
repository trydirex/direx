// SPDX-License-Identifier: AGPL-3.0-only
// The request context for /api/w/:workspaceId/*: who is asking, in which Workspace, with
// which role. A Workspace the caller is not a member of is 404, so its existence does not leak.
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { SESSION_CAP_MS, STEP_UP_WINDOWS, type Auth, type StepUpWindow } from "./adapters/auth";
import { memberRole } from "./adapters/repo";
import { can, type Permission, type Role } from "./domain/roles";

/**
 * The browser session behind this request, or null. Every Direx read of a session goes through here
 * (ADR 0037 rule 002). Once a session is a day old, Better Auth renews it and sends a new cookie;
 * that cookie goes onto this response. Dropped, the browser keeps the first cookie's Max-Age and
 * signs the person out 7 days after sign-in however much they use Direx. Its `no-store` comes along
 * too, so no shared cache keeps a response that carries a session cookie.
 */
export async function readSession(auth: () => Auth, c: Context) {
  return (await readSessionWithCookies(auth, c)).response;
}

async function readSessionWithCookies(auth: () => Auth, c: Context) {
  const { headers, response } = await auth().api.getSession({ headers: c.req.raw.headers, returnHeaders: true });
  const cookies = headers.getSetCookie();
  for (const cookie of cookies) c.header("Set-Cookie", cookie, { append: true });
  const setsCookies = cookies.length > 0;
  const cacheControl = setsCookies ? "no-store" : headers.get("cache-control");
  if (cacheControl) c.header("Cache-Control", cacheControl);
  return { response: await withinCap(auth, response), setsCookies };
}

type Session = Awaited<ReturnType<Auth["api"]["getSession"]>>;

/** A session past SESSION_CAP_MS since sign-in is deleted and counts as none, however recently it was used (ADR 0037 rule 003). */
async function withinCap(auth: () => Auth, s: Session): Promise<Session> {
  if (!s || Date.now() - new Date(s.session.createdAt).getTime() <= SESSION_CAP_MS) return s;
  await (await auth().$context).internalAdapter.deleteSession(s.session.token);
  return null;
}

/** The session for one of Better Auth's own routes, ended first if past the cap. Copies no cookie onto that route's answer. */
export async function sessionWithinCap(auth: () => Auth, headers: Headers): Promise<Session> {
  return withinCap(auth, await auth().api.getSession({ headers }));
}

export type { StepUpWindow };

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
// The scheme is case-insensitive in HTTP, so "bearer dxt_" is a token too.
const EXTERNAL_TOKEN = /^bearer\s+dxt_/i;

/**
 * An External token opens the door and nothing else (ADR 0032 rule 002). Every route outside
 * `doorBase` refuses one; any other Authorization value, such as a provider's on a webhook, passes.
 */
export function refuseExternalTokens(doorBase: string) {
  return createMiddleware(async (c, next) => {
    if (EXTERNAL_TOKEN.test(c.req.header("authorization") ?? "") && !c.req.path.startsWith(`${doorBase}/`)) return c.json({ error: "token_not_accepted" }, 401);
    await next();
  });
}

/** `deleted: true` lets a deleted Workspace through until its purge; only its export routes ask for that. */
export function requireMember(auth: () => Auth, o: { deleted?: boolean } = {}) {
  return createMiddleware<MemberEnv>(async (c, next) => {
    // A Workspace route takes a session only. Sessions are cookies, so any Authorization header is a
    // credential meant for somewhere else, an External token included (ADR 0032 rule 002).
    if (c.req.header("authorization") !== undefined) return c.json({ error: "token_not_accepted" }, 401);
    const { response: s, setsCookies } = await readSessionWithCookies(auth, c);
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
    // Handlers may supply their own cache policy. It must not override no-store on a cookie response.
    if (setsCookies) c.header("Cache-Control", "no-store");
  });
}

export function requirePermission(p: Permission) {
  return createMiddleware<MemberEnv>(async (c, next) => {
    if (!can(c.get("member").role, p)) return c.json({ error: "forbidden" }, 403);
    await next();
  });
}

/**
 * Step-up: whether this sign-in is recent enough for `window` (STEP_UP_WINDOWS). Every check names
 * its window (ADR 0037 rule 004).
 */
// ponytail: the "short" defaults here and on requireStepUp keep today's 10 minutes for checks outside
// identity, items and lessons until they name a window; then drop both so no check can leave it out.
export const steppedUp = (m: { signedInAt: Date }, window: StepUpWindow = "short", now = new Date()) => now.getTime() - m.signedInAt.getTime() <= STEP_UP_WINDOWS[window];

export function requireStepUp(window: StepUpWindow = "short", now: () => Date = () => new Date()) {
  return createMiddleware<MemberEnv>(async (c, next) => {
    if (!steppedUp(c.get("member"), window, now())) return c.json({ error: "step_up_required" }, 403);
    await next();
  });
}
