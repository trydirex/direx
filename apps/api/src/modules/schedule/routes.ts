// SPDX-License-Identifier: AGPL-3.0-only
// A Mailbox's daily limit and sending hours, the Workspace time zone they are read in, and each
// Mailbox's day against its limit for the Calendar. identity's Workspace middleware has resolved the caller.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { can, requirePermission, type MemberEnv } from "../identity/index";
import { mailboxDays } from "./application/mailbox";
import { mailboxPace, setMailboxPace, setTimeZone, timeZoneOf } from "./application/settings";

const ErrorBody = z.object({ error: z.string() }).openapi("ScheduleError");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { "application/json": { schema } } } });
const errors = { 400: json(ErrorBody, "Invalid request"), 401: json(ErrorBody, "Not signed in"), 403: json(ErrorBody, "Not allowed"), 404: json(ErrorBody, "Not found"), 409: json(ErrorBody, "Refused, with a named reason") };
const ws = z.object({ workspaceId: z.uuid() });
const one = z.object({ workspaceId: z.uuid(), credentialId: z.uuid() });

const Pace = z
  .object({
    dailyLimit: z.number().int().min(1).max(500),
    /** Minutes from midnight in the Workspace's time zone. */
    sendFrom: z.number().int().min(0).max(1439),
    sendUntil: z.number().int().min(1).max(1440),
    sendWeekends: z.boolean(),
  })
  .openapi("MailboxPace");

const paceRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/mailboxes/{credentialId}/pace",
  middleware: [requirePermission("workspace.read")],
  request: { params: one },
  responses: { 200: json(z.object({ pace: Pace, timeZone: z.string() }).openapi("MailboxPaceView"), "The Mailbox's pace"), ...errors },
});
const setPaceRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/mailboxes/{credentialId}/pace",
  middleware: [requirePermission("credential.connect")],
  request: { params: one, ...body(Pace) },
  responses: { 200: json(z.object({ ok: z.literal(true) }), "Saved"), ...errors },
});
const zoneRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/time-zone",
  middleware: [requirePermission("workspace.settings")],
  request: { params: ws, ...body(z.object({ timeZone: z.string().min(1).max(64) })) },
  responses: { 200: json(z.object({ ok: z.literal(true) }), "Saved"), ...errors },
});
const readZoneRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/time-zone",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: { 200: json(z.object({ timeZone: z.string() }).openapi("WorkspaceTimeZone"), "The Workspace's time zone"), ...errors },
});
const daysRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/mailbox-days",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws, query: z.object({ from: z.iso.datetime(), to: z.iso.datetime() }) },
  responses: {
    200: json(
      z.object({ days: z.array(z.object({ credentialId: z.uuid(), name: z.string(), day: z.string(), counted: z.number().int(), limit: z.number().int() })) }).openapi("MailboxDays"),
      "Each Mailbox's emails against its limit, per day",
    ),
    ...errors,
  },
});

export function scheduleRoutes() {
  return new OpenAPIHono<MemberEnv>()
    .openapi(paceRoute, async (c) => {
      const { workspaceId, credentialId } = c.req.valid("param");
      const found = await mailboxPace(workspaceId, credentialId);
      return found ? c.json(found, 200) : c.json({ error: "not_found" }, 404);
    })
    .openapi(setPaceRoute, async (c) => {
      const { workspaceId, credentialId } = c.req.valid("param");
      const m = c.get("member");
      const r = await setMailboxPace(workspaceId, credentialId, c.req.valid("json"), { userId: m.userId, mayManage: can(m.role, "credential.manage") });
      if (r.ok) return c.json({ ok: true as const }, 200);
      return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : r.reason === "forbidden" ? 403 : 400);
    })
    .openapi(readZoneRoute, async (c) => c.json({ timeZone: await timeZoneOf(c.req.valid("param").workspaceId) }, 200))
    .openapi(zoneRoute, async (c) => {
      const r = await setTimeZone(c.req.valid("param").workspaceId, c.req.valid("json").timeZone);
      return r.ok ? c.json({ ok: true as const }, 200) : c.json({ error: r.reason }, 400);
    })
    .openapi(daysRoute, async (c) => {
      const { from, to } = c.req.valid("query");
      return c.json({ days: await mailboxDays(c.req.valid("param").workspaceId, new Date(from), new Date(to)) }, 200);
    });
}
