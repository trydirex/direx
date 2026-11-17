// SPDX-License-Identifier: AGPL-3.0-only
// Ask Direx over HTTP. A person only ever reads their own conversation. Asking takes the right to
// edit drafts, since a reply can propose Items.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { requirePermission, type MemberEnv } from "../identity/index";
import type { Ask } from "./application/messages";
import { AREAS, SCREENS } from "./definitions/ask";

const ErrorBody = z.object({ error: z.string() }).openapi("AskError");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const errors = { 400: json(ErrorBody, "Invalid request"), 401: json(ErrorBody, "Not signed in"), 403: json(ErrorBody, "Not allowed"), 404: json(ErrorBody, "Not found") };
const ws = z.object({ workspaceId: z.uuid() });

const Reply = z.object({ kind: z.enum(["answer", "question", "cannot", "next_step", "rewrite", "reschedule", "fact", "start"]), text: z.string(), cites: z.array(z.uuid()).optional(), itemId: z.uuid().optional(), looked: z.array(z.string()).optional(), before: z.object({ subject: z.string().optional(), text: z.string() }).optional() }).openapi("AskReply");
const Message = z
  .object({
    id: z.uuid(),
    text: z.string(),
    itemId: z.uuid().nullable(),
    agent: z.string().nullable(),
    createdAt: z.iso.datetime(),
    status: z.enum(["working", "done", "stopped"]),
    steps: z.array(z.string()),
    reply: Reply.nullable(),
    // Under an accepted start: where its work stands, in fixed words, and the Items it made.
    done: z.object({ state: z.enum(["running", "done", "failed", "cancelled", "refused"]), text: z.string(), itemIds: z.array(z.uuid()) }).optional(),
  })
  .openapi("AskMessage");

const postRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/ask/messages",
  middleware: [requirePermission("item.edit")],
  request: { params: ws, body: { content: { "application/json": { schema: z.strictObject({ text: z.string().trim().min(1).max(4000), itemId: z.uuid().optional(), agent: z.enum(AREAS).optional(), looking: z.strictObject({ screen: z.enum(SCREENS), campaignId: z.uuid().optional() }).optional() }) } } } },
  responses: { 200: json(z.object({ ok: z.literal(true), id: z.uuid() }), "Asked"), ...errors },
});
const listRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/ask/messages",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: { 200: json(z.object({ messages: z.array(Message), on: z.boolean() }), "Your conversation, and whether Ask runs"), ...errors },
});

export function askRoutes({ ask }: { ask: () => Ask }) {
  const app = new OpenAPIHono<MemberEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    },
  });
  return app
    .openapi(postRoute, async (c) => {
      const m = c.get("member");
      const r = await ask().post(m.workspaceId, m.userId, c.req.valid("json"));
      return r.ok ? c.json({ ok: true as const, id: r.id }, 200) : c.json({ error: r.reason }, 404);
    })
    .openapi(listRoute, async (c) => {
      const m = c.get("member");
      const messages = await ask().list(m.workspaceId, m.userId);
      return c.json({ messages: messages.map((x) => ({ ...x, createdAt: x.createdAt.toISOString(), reply: x.reply as z.infer<typeof Reply> | null })), on: ask().on() }, 200);
    });
}
