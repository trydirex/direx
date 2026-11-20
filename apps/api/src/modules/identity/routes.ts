// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { APIError } from "better-auth/api";
import { getCookie, setCookie } from "hono/cookie";
import type { Auth } from "./adapters/auth";
import { claimServer, isServerAdmin } from "./application/admission";
import { createOrganization, listDeletedWorkspaces, listMyWorkspaces } from "./application/orgs";
import { INVITE_COOKIE, type Admission } from "./domain/admission";
import { ROLES } from "./domain/roles";
import { requireMember, STEP_UP_MS, type MemberEnv } from "./middleware";

const ErrorBody = z.object({ error: z.string() }).openapi("Error");
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const Role = z.enum(ROLES).openapi("Role");
const Me = z.object({ user: z.object({ id: z.uuid(), email: z.string(), name: z.string(), hasPassword: z.boolean() }) }).openapi("Me");
const Organization = z.object({ id: z.uuid(), name: z.string() }).openapi("Organization");
const Workspace = z.object({ id: z.uuid(), name: z.string(), role: Role }).openapi("Workspace");
const MyWorkspace = Workspace.extend({ organization: Organization }).openapi("MyWorkspace");
const Name = z.string().trim().min(1).max(100);
/** A raw invite or bootstrap token: 32 random bytes as hex. */
const Token = z.string().regex(/^[0-9a-f]{64}$/);

const meRoute = createRoute({
  method: "get",
  path: "/api/me",
  responses: { 200: json(Me, "The signed-in user"), 401: json(ErrorBody, "Not signed in") },
});

const myWorkspacesRoute = createRoute({
  method: "get",
  path: "/api/me/workspaces",
  responses: {
    200: json(z.object({ workspaces: z.array(MyWorkspace) }), "The Workspaces the user is a member of"),
    401: json(ErrorBody, "Not signed in"),
  },
});

/** A deleted Workspace may be purged this long after its deletion, never sooner (purge_refusal, migration 0148; ADR 0030 Q2). */
const PURGE_GRACE_MS = 30 * 86_400_000;
const DeletedWorkspace = z
  .object({ id: z.uuid(), name: z.string(), organization: Organization, deletedAt: z.iso.datetime(), purgeFrom: z.iso.datetime() })
  .openapi("DeletedWorkspace");

// Outside /api/w/, as the export routes are: a deleted Workspace's Owner finds it here and exports it until
// the purge (ADR 0030 rule 008). It lists names and dates only; nothing else of a deleted Workspace opens.
const deletedWorkspacesRoute = createRoute({
  method: "get",
  path: "/api/me/deleted-workspaces",
  responses: {
    200: json(z.object({ workspaces: z.array(DeletedWorkspace) }), "Deleted Workspaces the user is an Owner of, not yet being purged, oldest deletion first"),
    401: json(ErrorBody, "Not signed in"),
  },
});

const createOrgRoute = createRoute({
  method: "post",
  path: "/api/orgs",
  request: { body: { content: { "application/json": { schema: z.object({ name: Name, workspaceName: Name }) } } } },
  responses: {
    201: json(z.object({ organization: Organization, workspace: Workspace }), "The new Organization and its first Workspace"),
    400: json(ErrorBody, "Invalid request"),
    401: json(ErrorBody, "Not signed in"),
    403: json(ErrorBody, "server_admins_only: on this server only a Server admin creates Organizations"),
  },
});

const workspaceRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}",
  request: { params: z.object({ workspaceId: z.string() }) },
  responses: {
    200: json(z.object({ workspace: Workspace }), "The Workspace and the caller's role"),
    401: json(ErrorBody, "Not signed in"),
    404: json(ErrorBody, "No such Workspace for this user"),
  },
});

// The invite and bootstrap pages hand their token over here before sign-in, so every sign-up
// route, the OAuth callbacks included, can read it (ADR 0024). Only a cookie carries it on.
const holdTokenRoute = createRoute({
  method: "post",
  path: "/api/admission/token",
  request: { body: { content: { "application/json": { schema: z.object({ token: Token }) } } } },
  responses: { 200: json(z.object({ ok: z.literal(true) }), "The token is held for 30 minutes"), 400: json(ErrorBody, "Not a token") },
});

// Server-wide facts a signed-in person's screens need: whether the server has a Server admin yet,
// and whether this person may create an Organization (ADR 0024).
const serverStatusRoute = createRoute({
  method: "get",
  path: "/api/server/status",
  responses: {
    200: json(
      z.object({ claimed: z.boolean(), canCreateOrganization: z.boolean(), serverAdmin: z.boolean() }).openapi("ServerStatus"),
      "This server, as the signed-in person sees it",
    ),
    401: json(ErrorBody, "Not signed in"),
  },
});

// The bootstrap page calls this once the person is signed in (DX-R-0024-005). With no token in the
// body it uses the held one, so sign-in never has to put the token in a link it mails.
const claimRoute = createRoute({
  method: "post",
  path: "/api/server/claim",
  request: { body: { content: { "application/json": { schema: z.object({ token: Token.optional() }) } } } },
  responses: {
    200: json(z.object({ ok: z.literal(true) }), "The caller is now this server's first Server admin"),
    400: json(ErrorBody, "Not a token"),
    401: json(ErrorBody, "Not signed in"),
    409: json(ErrorBody, "link_unusable: expired, revoked, used, or the server is claimed; unverified_email; link_needed: no token given or held"),
  },
});

// Before sign-in: which of Google and Microsoft this server is set up for, so the sign-in page
// shows only the buttons that work, and whether the server has no accounts yet, so a new server's
// page can lead to sign-up or the bootstrap link. It names providers, never a client ID or secret,
// and says nothing more about the server.
const signInOptionsRoute = createRoute({
  method: "get",
  path: "/api/sign-in-options",
  responses: {
    200: json(
      z.object({ google: z.boolean(), microsoft: z.boolean(), firstRun: z.enum(["sign_up", "needs_link"]).nullable() }).openapi("SignInOptions"),
      "The sign-in providers this server is set up for; firstRun is null once any account exists",
    ),
  },
});

// Someone who signed up with an email link, Google or Microsoft adds a password (ADR 0024).
// Behind step-up, as anyone holding a stolen session could otherwise lock in a way back.
const setPasswordRoute = createRoute({
  method: "post",
  path: "/api/account/password",
  request: { body: { content: { "application/json": { schema: z.object({ password: z.string().min(12).max(128) }) } } } },
  responses: {
    200: json(z.object({ ok: z.literal(true) }), "The account now signs in with this password too"),
    400: json(ErrorBody, "Invalid request"),
    401: json(ErrorBody, "Not signed in"),
    403: json(ErrorBody, "step_up_required"),
    409: json(ErrorBody, "password_already_set: change it with a reset link instead"),
  },
});

/** `auth` is resolved on first use, so building the OpenAPI document needs no secrets. */
export function identityRoutes(auth: () => Auth, baseURL: () => string, admission: () => Admission) {
  const session = (headers: Headers) => auth().api.getSession({ headers });
  const app = new OpenAPIHono<MemberEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
      }
    },
  });
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth().handler(c.req.raw));
  app.use("/api/w/:workspaceId", requireMember(auth));
  app.use("/api/w/:workspaceId/*", requireMember(auth));

  return app
    .openapi(signInOptionsRoute, async (c) => {
      const p = auth().options.socialProviders;
      const firstRun = (await admission().firstRun?.()) ?? null;
      return c.json({ google: !!p.google, microsoft: !!p.microsoft, firstRun }, 200);
    })
    .openapi(meRoute, async (c) => {
      const s = await session(c.req.raw.headers);
      if (!s) return c.json({ error: "not_signed_in" }, 401);
      const accounts = await auth().api.listUserAccounts({ headers: c.req.raw.headers });
      const hasPassword = accounts.some((a) => a.providerId === "credential");
      return c.json({ user: { id: s.user.id, email: s.user.email, name: s.user.name, hasPassword } }, 200);
    })
    .openapi(setPasswordRoute, async (c) => {
      const headers = c.req.raw.headers;
      const s = await session(headers);
      if (!s) return c.json({ error: "not_signed_in" }, 401);
      if (Date.now() - new Date(s.session.createdAt).getTime() > STEP_UP_MS) return c.json({ error: "step_up_required" }, 403);
      try {
        await auth().api.setPassword({ body: { newPassword: c.req.valid("json").password }, headers });
      } catch (e) {
        if (e instanceof APIError && e.body?.code === "PASSWORD_ALREADY_SET") return c.json({ error: "password_already_set" }, 409);
        throw e;
      }
      return c.json({ ok: true as const }, 200);
    })
    .openapi(myWorkspacesRoute, async (c) => {
      const s = await session(c.req.raw.headers);
      if (!s) return c.json({ error: "not_signed_in" }, 401);
      return c.json({ workspaces: await listMyWorkspaces(s.user.id) }, 200);
    })
    .openapi(deletedWorkspacesRoute, async (c) => {
      const s = await session(c.req.raw.headers);
      if (!s) return c.json({ error: "not_signed_in" }, 401);
      const list = await listDeletedWorkspaces(s.user.id);
      const workspaces = list.map((w) => ({ ...w, deletedAt: w.deletedAt.toISOString(), purgeFrom: new Date(w.deletedAt.getTime() + PURGE_GRACE_MS).toISOString() }));
      return c.json({ workspaces }, 200);
    })
    .openapi(createOrgRoute, async (c) => {
      const s = await session(c.req.raw.headers);
      if (!s) return c.json({ error: "not_signed_in" }, 401);
      // On self-host outside dev, only a Server admin (DX-R-0024-008).
      if (!(await admission().canCreateOrganization(s.user.id))) return c.json({ error: "server_admins_only" }, 403);
      const { name, workspaceName } = c.req.valid("json");
      return c.json(await createOrganization(s.user.id, { orgName: name, workspaceName }), 201);
    })
    .openapi(holdTokenRoute, (c) => {
      // Lax, so the cookie comes back on a provider's top-level redirect to the OAuth callback.
      setCookie(c, INVITE_COOKIE, c.req.valid("json").token, {
        httpOnly: true,
        secure: baseURL().startsWith("https:"),
        sameSite: "Lax",
        path: "/api",
        maxAge: 30 * 60,
      });
      return c.json({ ok: true as const }, 200);
    })
    .openapi(serverStatusRoute, async (c) => {
      const s = await session(c.req.raw.headers);
      if (!s) return c.json({ error: "not_signed_in" }, 401);
      const [{ claimed }, canCreateOrganization, serverAdmin] = await Promise.all([admission().status(), admission().canCreateOrganization(s.user.id), isServerAdmin(s.user.id)]);
      return c.json({ claimed, canCreateOrganization, serverAdmin }, 200);
    })
    .openapi(claimRoute, async (c) => {
      const s = await session(c.req.raw.headers);
      if (!s) return c.json({ error: "not_signed_in" }, 401);
      const token = c.req.valid("json").token ?? Token.safeParse(getCookie(c, INVITE_COOKIE)).data;
      if (!token) return c.json({ error: "link_needed" }, 409);
      const result = await claimServer(s.user.id, token);
      return result === "ok" ? c.json({ ok: true as const }, 200) : c.json({ error: result }, 409);
    })
    .openapi(workspaceRoute, (c) => {
      const m = c.get("member");
      return c.json({ workspace: { id: m.workspaceId, name: m.workspaceName, role: m.role } }, 200);
    });
}
