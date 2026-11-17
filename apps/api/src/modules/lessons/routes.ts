// SPDX-License-Identifier: AGPL-3.0-only
// Agent lessons over HTTP. Anyone who may edit a Draft may propose one; changing or withdrawing a
// lesson takes the rule-granting permission and a recent sign-in, like accepting one.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { FIELDS } from "../facts/index";
import { requirePermission, requireStepUp, type MemberEnv } from "../identity/index";
import type { Lessons } from "./application/lessons";
import { MAX_LESSON_CHARS } from "./domain/lessons";

const ErrorBody = z.object({ error: z.string(), reasons: z.array(z.string()).optional() }).openapi("LessonError");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const errors = {
  400: json(ErrorBody, "Invalid request"),
  401: json(ErrorBody, "Not signed in"),
  403: json(ErrorBody, "Not allowed, or step-up required"),
  404: json(ErrorBody, "Not found"),
  409: json(ErrorBody, "Refused"),
};
const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { "application/json": { schema } } } });
const ws = z.object({ workspaceId: z.uuid() });
const one = ws.extend({ id: z.uuid() });
// The words are checked and trimmed again by the module; this only bounds what is read.
const Text = z.string().min(1).max(MAX_LESSON_CHARS * 2);
// Where a lesson came from: the proposal Item accepted to make it, the edit it was suggested after
// ("campaign:{id}/{step}[/{person}]"), and who proposed it. Each is null where it wasn't recorded.
const Origin = z.object({ itemId: z.uuid().nullable(), sourceRef: z.string().nullable(), proposedBy: z.string().nullable() });
const Lesson = z.object({ id: z.uuid(), agent: z.string(), version: z.number(), text: z.string(), createdAt: z.iso.datetime(), origin: Origin }).openapi("Lesson");
const Ok = json(z.object({ ok: z.literal(true), itemId: z.uuid().optional(), version: z.number().optional() }), "Done");

const proposeRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/lessons",
  middleware: [requirePermission("item.edit")],
  request: { params: ws, ...body(z.strictObject({ agent: z.string().min(1).max(100), text: Text, sourceRef: z.string().max(300).nullable().optional() })) },
  responses: { 200: Ok, ...errors },
});
const listRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/lessons",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws, query: z.object({ agent: z.string().max(100).optional() }) },
  responses: { 200: json(z.object({ lessons: z.array(Lesson) }), "Live lessons"), ...errors },
});
const rewriteRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/lessons/{id}/rewrite",
  middleware: [requirePermission("rule.grant"), requireStepUp()],
  request: { params: one, ...body(z.strictObject({ version: z.number().int().positive(), text: Text })) },
  responses: { 200: Ok, ...errors },
});
const retireRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/lessons/{id}/retire",
  middleware: [requirePermission("rule.grant"), requireStepUp()],
  request: { params: one, ...body(z.strictObject({ version: z.number().int().positive() })) },
  responses: { 200: Ok, ...errors },
});
const toFactRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/lessons/{id}/to-fact",
  middleware: [requirePermission("item.edit")],
  request: { params: one, ...body(z.strictObject({ version: z.number().int().positive(), field: z.enum(FIELDS), subject: z.string().max(200).optional(), sourceLabel: z.string().min(1).max(200) })) },
  responses: { 200: Ok, ...errors },
});

const status = (reason: string) => (reason === "not_found" ? 404 : 409);

/** `agents` are the drafting agents a lesson may name; anything else is refused. */
export function lessonRoutes({ lessons, agents, definitionVersion }: { lessons: () => Lessons; agents: () => readonly string[]; definitionVersion: (agent: string) => number | null }) {
  const app = new OpenAPIHono<MemberEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    },
  });
  const refused = (c: { json: (b: object, s: 404 | 409) => Response }, r: { reason: string; reasons?: string[] }) => c.json({ error: r.reason, ...(r.reasons && { reasons: r.reasons }) }, status(r.reason));

  return app
    .openapi(proposeRoute, async (c) => {
      const m = c.get("member");
      const b = c.req.valid("json");
      if (!agents().includes(b.agent)) return c.json({ error: "unknown_agent" }, 404);
      const r = await lessons().propose(m.workspaceId, { agent: b.agent, text: b.text, sourceRef: b.sourceRef ?? null, definitionVersion: definitionVersion(b.agent), userId: m.userId });
      return r.ok ? c.json({ ok: true as const, itemId: r.item.id }, 200) : (refused(c as never, r) as never);
    })
    .openapi(listRoute, async (c) => {
      const m = c.get("member");
      const rows = await lessons().list(m.workspaceId, c.req.valid("query").agent);
      return c.json({ lessons: rows.map((l) => ({ id: l.id, agent: l.agent, version: l.version, text: l.text, createdAt: l.createdAt.toISOString(), origin: l.origin })) }, 200);
    })
    .openapi(rewriteRoute, async (c) => {
      const m = c.get("member");
      const b = c.req.valid("json");
      const r = await lessons().rewrite(m.workspaceId, { lessonId: c.req.valid("param").id, version: b.version, text: b.text, userId: m.userId });
      return r.ok ? c.json({ ok: true as const, version: r.version }, 200) : (refused(c as never, r) as never);
    })
    .openapi(retireRoute, async (c) => {
      const m = c.get("member");
      const r = await lessons().retire(m.workspaceId, { lessonId: c.req.valid("param").id, version: c.req.valid("json").version, userId: m.userId });
      return r.ok ? c.json({ ok: true as const }, 200) : (refused(c as never, r) as never);
    })
    .openapi(toFactRoute, async (c) => {
      const m = c.get("member");
      const b = c.req.valid("json");
      const r = await lessons().toFact(m.workspaceId, { lessonId: c.req.valid("param").id, version: b.version, field: b.field, ...(b.subject && { subject: b.subject }), sourceLabel: b.sourceLabel, userId: m.userId });
      return r.ok ? c.json({ ok: true as const, itemId: r.item.id }, 200) : (refused(c as never, r) as never);
    });
}
