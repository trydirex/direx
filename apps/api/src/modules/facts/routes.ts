// SPDX-License-Identifier: AGPL-3.0-only
// Brand over HTTP. identity's Workspace middleware has already resolved the caller. The source
// and actor come from the session, never the request. Accepting, dismissing and deciding a
// proposal are items routes.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { requirePermission, type MemberEnv } from "../identity/index";
import type { Facts } from "./application/create";
import { FIELDS, MAX_FACT_CHARS } from "./domain/slots";

const ErrorBody = z.object({ error: z.string() }).openapi("FactError");
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { "application/json": { schema } } } });
const errors = {
  400: json(ErrorBody, "Invalid request"),
  401: json(ErrorBody, "Not signed in"),
  403: json(ErrorBody, "Not allowed"),
  404: json(ErrorBody, "Not found"),
  409: json(ErrorBody, "Changed since you loaded it"),
};
const ws = z.object({ workspaceId: z.uuid() });
const one = ws.extend({ id: z.uuid() });
const Field = z.enum(FIELDS);
const Source = z
  .object({ kind: z.enum(["person", "website", "document", "chat", "edits"]), label: z.string(), url: z.string().optional(), retrievedAt: z.string().optional() })
  .openapi("FactSource");
const Confidence = z.enum(["low", "medium", "high"]);
const Fact = z
  .object({ id: z.uuid(), field: Field, subject: z.string(), value: z.string(), version: z.number(), source: Source, confidence: Confidence, usable: z.boolean() })
  .openapi("Fact");
const FactVersion = z.object({ version: z.number(), value: z.string(), source: Source, confidence: Confidence, at: z.iso.datetime() }).openapi("FactVersion");
const Value = {
  field: Field,
  subject: z.string().max(200).optional(),
  // Room over the cap, so a value just past it gets value_too_long, which says the limit.
  value: z.string().min(1).max(MAX_FACT_CHARS * 2),
};

// Voice (ADR 0022): how drafts should sound, apart from what they may claim. Saving needs item.approve.
const VoiceEntry = z
  .object({ id: z.uuid(), kind: z.enum(["example", "swap"]), text: z.string(), prefer: z.string().nullable(), source: z.enum(["person", "sample"]), at: z.iso.datetime() })
  .openapi("VoiceEntry");
const VoiceError = z.object({ error: z.string(), reasons: z.array(z.string()).optional() }).openapi("VoiceError");
const voiceErrors = { ...errors, 400: json(VoiceError, "Refused, with the reason"), 409: json(VoiceError, "Refused, with the reason") };
const voiceListRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/voice",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: { 200: json(z.object({ entries: z.array(VoiceEntry), pasteOpen: z.boolean() }), "Every live Voice entry, and whether pasting an example is open"), ...errors },
});
const swapRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/voice/swaps",
  middleware: [requirePermission("item.approve")],
  request: { params: ws, ...body(z.strictObject({ avoid: z.string().max(200), prefer: z.string().max(200) })) },
  responses: { 200: json(z.object({ id: z.uuid() }), "Saved"), ...voiceErrors },
});
const exampleRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/voice/examples",
  middleware: [requirePermission("item.approve")],
  request: { params: ws, ...body(z.strictObject({ text: z.string().max(5000) })) },
  responses: { 200: json(z.object({ id: z.uuid() }), "Checked and saved"), ...voiceErrors },
});
const voiceRetireRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/voice/{id}/retire",
  middleware: [requirePermission("item.approve")],
  request: { params: one },
  responses: { 200: json(z.object({ ok: z.literal(true) }), "Retired; its versions stay"), ...errors },
});
// Refusals a person can fix by changing the words are 400; the rest (full, check closed or unavailable) are 409.
const FIXABLE = new Set(["voice_empty", "voice_too_long", "voice_has_email", "voice_has_phone", "voice_swap_same", "voice_check_refused"]);

const listRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/facts",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: { 200: json(z.object({ facts: z.array(Fact) }), "Every live fact"), ...errors },
});
const versionsRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/facts/{id}/versions",
  middleware: [requirePermission("workspace.read")],
  request: { params: one },
  responses: { 200: json(z.object({ versions: z.array(FactVersion) }), "Every version, oldest first"), ...errors },
});
const setRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/facts",
  middleware: [requirePermission("item.approve")],
  request: { params: ws, ...body(z.strictObject({ ...Value, expectedVersion: z.number().int().positive().optional() })) },
  responses: { 200: json(z.object({ id: z.uuid(), version: z.number() }), "Saved"), ...errors },
});
const retireRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/facts/{id}/retire",
  middleware: [requirePermission("item.approve")],
  request: { params: one },
  responses: { 200: json(z.object({ ok: z.literal(true) }), "Retired; its versions stay"), ...errors },
});
const proposeRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/facts/proposals",
  middleware: [requirePermission("item.edit")],
  request: { params: ws, ...body(z.strictObject(Value)) },
  responses: { 200: json(z.object({ itemId: z.uuid().nullable() }), "Waiting for a person, or null when Brand already says this"), ...errors },
});

export function factRoutes({ facts }: { facts: () => Facts }) {
  const app = new OpenAPIHono<MemberEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
      }
    },
  });

  return app
    .openapi(listRoute, async (c) => {
      const rows = await facts().list(c.get("member").workspaceId);
      return c.json({ facts: rows.map((f) => ({ id: f.id, field: f.field as (typeof FIELDS)[number], subject: f.subject, value: f.value, version: f.currentVersion, source: f.source, confidence: f.confidence, usable: f.usable })) }, 200);
    })
    .openapi(versionsRoute, async (c) => {
      const rows = await facts().history(c.get("member").workspaceId, c.req.valid("param").id);
      if (!rows.length) return c.json({ error: "not_found" }, 404);
      return c.json({ versions: rows.map((v) => ({ version: v.version, value: v.value, source: v.source as z.infer<typeof Source>, confidence: v.confidence as z.infer<typeof Confidence>, at: v.at.toISOString() })) }, 200);
    })
    .openapi(setRoute, async (c) => {
      const m = c.get("member");
      const r = await facts().set(m.workspaceId, { ...c.req.valid("json"), source: { kind: "person", label: m.email }, confidence: "high", actor: { userId: m.userId } });
      if (r.ok) return c.json({ id: r.id, version: r.version }, 200);
      return r.reason === "blank_value" || r.reason === "value_too_long" ? c.json({ error: r.reason }, 400) : c.json({ error: r.reason }, 409);
    })
    .openapi(retireRoute, async (c) => {
      const m = c.get("member");
      const r = await facts().retire(m.workspaceId, c.req.valid("param").id, { userId: m.userId });
      return r.ok ? c.json({ ok: true as const }, 200) : c.json({ error: r.reason }, 404);
    })
    .openapi(proposeRoute, async (c) => {
      const m = c.get("member");
      const r = await facts().propose(m.workspaceId, { ...c.req.valid("json"), source: { kind: "person", label: m.email }, confidence: "high", actor: { userId: m.userId } });
      return r.ok ? c.json({ itemId: r.item?.id ?? null }, 200) : c.json({ error: r.reason }, 400);
    })
    .openapi(voiceListRoute, async (c) => {
      const rows = await facts().listVoice(c.get("member").workspaceId);
      return c.json({ entries: rows.map((v) => ({ ...v, at: v.at.toISOString() })), pasteOpen: facts().pasteOpen() }, 200);
    })
    .openapi(swapRoute, async (c) => {
      const m = c.get("member");
      const r = await facts().addSwap(m.workspaceId, { ...c.req.valid("json"), userId: m.userId });
      if (r.ok) return c.json({ id: r.id }, 200);
      return c.json({ error: r.reason }, FIXABLE.has(r.reason) ? 400 : 409);
    })
    .openapi(exampleRoute, async (c) => {
      const m = c.get("member");
      const r = await facts().addExample(m.workspaceId, { text: c.req.valid("json").text, userId: m.userId });
      if (r.ok) return c.json({ id: r.id }, 200);
      return c.json({ error: r.reason, ...(r.reasons && { reasons: r.reasons }) }, FIXABLE.has(r.reason) ? 400 : 409);
    })
    .openapi(voiceRetireRoute, async (c) => {
      const m = c.get("member");
      const r = await facts().retireVoice(m.workspaceId, c.req.valid("param").id, m.userId);
      return r.ok ? c.json({ ok: true as const }, 200) : c.json({ error: r.reason }, 404);
    });
}
