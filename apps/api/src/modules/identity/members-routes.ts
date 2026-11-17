// SPDX-License-Identifier: AGPL-3.0-only
// Members, invites, the audit log and Workspace deletion. The Workspace middleware from
// routes.ts has already resolved the caller; each route adds its permission and step-up.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Auth } from "./adapters/auth";
import { acceptInvite, createInvite, listInvites, previewInvite, revokeInvite, type InviteDeps } from "./application/invites";
import { auditLog, changeRole, deleteWorkspace, listMembers, removeMember, type OnDelete, type OnMemberChange } from "./application/members";
import { ROLES } from "./domain/roles";
import { requirePermission, requireStepUp, type MemberEnv } from "./middleware";

const ErrorBody = z.object({ error: z.string() }).openapi("Error");
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const Role = z.enum(ROLES).openapi("Role");
const ws = z.object({ workspaceId: z.uuid() });
const errors = {
  400: json(ErrorBody, "Invalid request"),
  401: json(ErrorBody, "Not signed in"),
  403: json(ErrorBody, "Not allowed, or step-up required"),
  404: json(ErrorBody, "Not found"),
  409: json(ErrorBody, "Refused by a membership rule"),
};
const Member = z
  .object({ userId: z.uuid(), email: z.string(), name: z.string(), role: Role, createdAt: z.iso.datetime() })
  .openapi("Member");
const Invite = z.object({ id: z.uuid(), email: z.string(), role: Role, expiresAt: z.iso.datetime() }).openapi("Invite");
const AuditEntry = z
  .object({
    event: z.string(),
    subjectUserId: z.uuid().nullable(),
    subjectEmail: z.string().nullable(),
    fromRole: z.string().nullable(),
    toRole: z.string().nullable(),
    stepUp: z.boolean(),
    actorUserId: z.uuid().nullable(),
    actorSystem: z.string().nullable(),
    at: z.iso.datetime(),
  })
  .openapi("AuditEntry");
const Ok = z.object({ ok: z.literal(true) }).openapi("Ok");

// Refusals a person can fix by asking someone else are 403; rule conflicts are 409.
const STATUS = {
  forbidden: 403,
  admin_cannot_manage_owner: 403,
  wrong_email: 403,
  unverified_email: 403,
  not_member: 404,
  not_found: 404,
  last_owner: 409,
  already_member: 409,
  accepted: 409,
  revoked: 409,
  expired: 409,
} as const;

const route = <R extends Parameters<typeof createRoute>[0]>(r: R) => createRoute(r);
const members = (p: Parameters<typeof requirePermission>[0], stepUp = false) =>
  stepUp ? [requirePermission(p), requireStepUp()] : [requirePermission(p)];

const listMembersRoute = route({
  method: "get",
  path: "/api/w/{workspaceId}/members",
  middleware: members("workspace.read"),
  request: { params: ws },
  responses: { 200: json(z.object({ members: z.array(Member) }), "Members of the Workspace"), ...errors },
});
const changeRoleRoute = route({
  method: "patch",
  path: "/api/w/{workspaceId}/members/{userId}",
  middleware: members("workspace.members", true),
  request: { params: ws.extend({ userId: z.uuid() }), body: { content: { "application/json": { schema: z.object({ role: Role }) } } } },
  responses: { 200: json(Ok, "Role changed"), ...errors },
});
const removeMemberRoute = route({
  method: "delete",
  path: "/api/w/{workspaceId}/members/{userId}",
  middleware: members("workspace.members", true),
  request: { params: ws.extend({ userId: z.uuid() }) },
  responses: { 200: json(Ok, "Member removed"), ...errors },
});
const listInvitesRoute = route({
  method: "get",
  path: "/api/w/{workspaceId}/invites",
  middleware: members("workspace.members"),
  request: { params: ws },
  responses: { 200: json(z.object({ invites: z.array(Invite) }), "Pending invites"), ...errors },
});
const createInviteRoute = route({
  method: "post",
  path: "/api/w/{workspaceId}/invites",
  middleware: members("workspace.members"),
  request: { params: ws, body: { content: { "application/json": { schema: z.object({ email: z.email(), role: Role }) } } } },
  responses: {
    200: json(z.object({ invite: Invite, resent: z.literal(true) }), "This email already had a pending invite; it was sent again with a new link"),
    201: json(z.object({ invite: Invite, resent: z.literal(false) }), "Invite sent"),
    ...errors,
  },
});
const revokeInviteRoute = route({
  method: "delete",
  path: "/api/w/{workspaceId}/invites/{inviteId}",
  middleware: members("workspace.members"),
  request: { params: ws.extend({ inviteId: z.uuid() }) },
  responses: { 200: json(Ok, "Invite revoked"), ...errors },
});
const auditRoute = route({
  method: "get",
  path: "/api/w/{workspaceId}/audit",
  middleware: members("workspace.members"),
  request: { params: ws },
  responses: { 200: json(z.object({ entries: z.array(AuditEntry) }), "The latest 100 membership events"), ...errors },
});
const deleteWorkspaceRoute = route({
  method: "delete",
  path: "/api/w/{workspaceId}",
  middleware: members("workspace.delete", true),
  request: { params: ws },
  responses: { 200: json(Ok, "Workspace deleted"), ...errors },
});
const acceptRoute = route({
  method: "post",
  path: "/api/invites/accept",
  request: { body: { content: { "application/json": { schema: z.object({ workspaceId: z.uuid(), token: z.string().regex(/^[0-9a-f]{64}$/) }) } } } },
  responses: { 200: json(z.object({ workspace: z.object({ id: z.uuid(), role: Role }) }), "Joined the Workspace"), ...errors },
});
// A POST, so the token stays out of URLs and request logs.
const previewRoute = route({
  method: "post",
  path: "/api/invites/preview",
  request: { body: { content: { "application/json": { schema: z.object({ workspaceId: z.uuid(), token: z.string().regex(/^[0-9a-f]{64}$/) }) } } } },
  responses: {
    200: json(z.object({ workspace: z.object({ name: z.string() }), invitedBy: z.string() }), "The Workspace this invite joins, and who sent it"),
    ...errors,
  },
});

export function memberRoutes(auth: () => Auth, deps: () => InviteDeps, onDelete?: OnDelete, onMemberChange?: OnMemberChange) {
  const app = new OpenAPIHono<MemberEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
      }
    },
  });
  const iso = (d: Date) => d.toISOString();

  return app
    .openapi(listMembersRoute, async (c) => {
      const rows = await listMembers(c.get("member").workspaceId);
      return c.json({ members: rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })) }, 200);
    })
    .openapi(changeRoleRoute, async (c) => {
      const refused = await changeRole(c.get("member"), c.req.valid("param").userId, c.req.valid("json").role, onMemberChange);
      return refused ? c.json({ error: refused }, STATUS[refused]) : c.json({ ok: true as const }, 200);
    })
    .openapi(removeMemberRoute, async (c) => {
      const refused = await removeMember(c.get("member"), c.req.valid("param").userId, onMemberChange);
      return refused ? c.json({ error: refused }, STATUS[refused]) : c.json({ ok: true as const }, 200);
    })
    .openapi(listInvitesRoute, async (c) => {
      const rows = await listInvites(c.get("member").workspaceId);
      return c.json({ invites: rows.map((r) => ({ ...r, role: r.role as (typeof ROLES)[number], expiresAt: iso(r.expiresAt) })) }, 200);
    })
    .openapi(createInviteRoute, async (c) => {
      const r = await createInvite(c.get("member"), c.req.valid("json"), deps());
      if (!r.ok) return c.json({ error: r.reason }, STATUS[r.reason]);
      const invite = { ...r.invite, expiresAt: iso(r.invite.expiresAt) };
      return r.resent ? c.json({ invite, resent: true as const }, 200) : c.json({ invite, resent: false as const }, 201);
    })
    .openapi(revokeInviteRoute, async (c) => {
      const refused = await revokeInvite(c.get("member"), c.req.valid("param").inviteId);
      return refused ? c.json({ error: refused }, STATUS[refused]) : c.json({ ok: true as const }, 200);
    })
    .openapi(auditRoute, async (c) => {
      const rows = await auditLog(c.get("member").workspaceId);
      return c.json(
        { entries: rows.map(({ id: _id, workspaceId: _w, ...r }) => ({ ...r, at: iso(r.at) })) },
        200,
      );
    })
    .openapi(deleteWorkspaceRoute, async (c) => {
      const refused = await deleteWorkspace(c.get("member"), onDelete);
      return refused ? c.json({ error: refused }, STATUS[refused]) : c.json({ ok: true as const }, 200);
    })
    .openapi(acceptRoute, async (c) => {
      const s = await auth().api.getSession({ headers: c.req.raw.headers });
      if (!s) return c.json({ error: "not_signed_in" }, 401);
      const { workspaceId, token } = c.req.valid("json");
      const r = await acceptInvite(s.user, workspaceId, token);
      return r.ok ? c.json({ workspace: { id: workspaceId, role: r.role } }, 200) : c.json({ error: r.reason }, STATUS[r.reason]);
    })
    .openapi(previewRoute, async (c) => {
      const s = await auth().api.getSession({ headers: c.req.raw.headers });
      if (!s) return c.json({ error: "not_signed_in" }, 401);
      const { workspaceId, token } = c.req.valid("json");
      const r = await previewInvite(s.user, workspaceId, token);
      return r.ok ? c.json({ workspace: { name: r.workspaceName }, invitedBy: r.invitedBy }, 200) : c.json({ error: r.reason }, STATUS[r.reason]);
    });
}
