// SPDX-License-Identifier: AGPL-3.0-only
// The competitor list over HTTP. identity's Workspace middleware has already resolved the caller;
// who added a competitor comes from the session, never the request.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { requirePermission, type MemberEnv } from "../identity/index";
import type { Competitors } from "./application/competitors";
import type { Snapshots } from "./application/snapshots";
import { MAX_NAME_CHARS, MAX_URL_CHARS, SOURCES, type Source } from "./domain/competitor";
import { LABELS, type Label } from "./domain/labels";

const ErrorBody = z.object({ error: z.string() }).openapi("CompetitorError");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { "application/json": { schema } } } });
const errors = {
  400: json(ErrorBody, "Invalid request"),
  401: json(ErrorBody, "Not signed in"),
  403: json(ErrorBody, "Not allowed"),
  404: json(ErrorBody, "Not found"),
  409: json(ErrorBody, "Refused: the list is full or the name is taken"),
};
const ws = z.object({ workspaceId: z.uuid() });
const one = ws.extend({ id: z.uuid() });
// Rules beyond the length (scheme, at least one URL) are the domain's, so a refusal names them.
const Url = z.string().max(MAX_URL_CHARS).nullable();
const Fields = { name: z.string().max(MAX_NAME_CHARS + 50), pricingUrl: Url.optional(), changelogUrl: Url.optional(), landingUrl: Url.optional(), comparisonUrl: Url.optional() };
const Competitor = z
  .object({ id: z.uuid(), name: z.string(), pricingUrl: z.string().nullable(), changelogUrl: z.string().nullable(), landingUrl: z.string().nullable(), comparisonUrl: z.string().nullable() })
  .openapi("Competitor");
const Check = z
  .object({ source: z.enum(SOURCES), url: z.string(), result: z.enum(["readable", "no_prices", "robots_disallowed", "not_html", "too_big", "failed"]), detail: z.string().optional(), prices: z.array(z.string()).optional() })
  .openapi("CompetitorCheck");
const Saved = z.object({ competitor: Competitor, checks: z.array(Check) });

// The latest weekly read of each page. A read whose url differs from the row's is of a URL since edited.
const LastRead = z.object({ competitorId: z.uuid(), source: z.enum(SOURCES), url: z.string(), readAt: z.iso.datetime(), failure: z.string().nullable() }).openapi("CompetitorRead");
const ChangeDetail = z
  .union([
    z.object({ added: z.array(z.string()), removed: z.array(z.string()).optional() }),
    z.object({ part: z.enum(["title", "description", "headline", "subhead"]), before: z.string().nullable(), after: z.string().nullable() }),
    z.object({ rewritten: z.object({ added: z.number(), removed: z.number() }) }),
  ])
  .openapi("CompetitorChangeDetail");
// The classifier's label: all null until a run labels the Change.
const Change = z
  .object({
    id: z.uuid(),
    source: z.enum(SOURCES),
    detail: ChangeDetail,
    at: z.iso.datetime(),
    label: z.enum(LABELS).nullable(),
    kind: z.string().nullable(),
    sameAs: z.uuid().nullable(),
    reason: z.string().nullable(),
    // The counter-move Item this answer belongs to, once one is made.
    itemId: z.uuid().nullable(),
  })
  .openapi("CompetitorChange");

const listRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/competitors",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: { 200: json(z.object({ competitors: z.array(Competitor), reads: z.array(LastRead) }), "The list, oldest first, and each page's latest weekly read"), ...errors },
});
const changesRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/competitors/{id}/changes",
  middleware: [requirePermission("workspace.read")],
  request: { params: one },
  responses: { 200: json(z.object({ changes: z.array(Change) }), "The last 4 weeks of Changes, newest first"), ...errors },
});
const addRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/competitors",
  middleware: [requirePermission("workspace.settings")],
  request: { params: ws, ...body(z.strictObject(Fields)) },
  responses: { 200: json(Saved, "Added, with a check of each URL"), ...errors },
});
const editRoute = createRoute({
  method: "patch",
  path: "/api/w/{workspaceId}/competitors/{id}",
  middleware: [requirePermission("workspace.settings")],
  request: { params: one, ...body(z.strictObject({ ...Fields, name: Fields.name.optional() })) },
  responses: { 200: json(Saved, "Changed, with a check of each URL that changed"), ...errors },
});
const removeRoute = createRoute({
  method: "delete",
  path: "/api/w/{workspaceId}/competitors/{id}",
  middleware: [requirePermission("workspace.settings")],
  request: { params: one },
  responses: { 200: json(z.object({ ok: z.literal(true) }), "Removed"), ...errors },
});
const checkRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/competitors/{id}/check",
  middleware: [requirePermission("workspace.settings")],
  request: { params: one },
  responses: { 200: json(z.object({ checks: z.array(Check) }), "Every URL on the row, read again"), ...errors },
});

const status = (reason: string) => (reason === "not_found" ? 404 : reason === "too_many" || reason === "name_taken" ? 409 : 400);

export function competitorRoutes(deps: { competitors: () => Competitors; snapshots: () => Snapshots }) {
  const { competitors, snapshots } = deps;
  return new OpenAPIHono<MemberEnv>()
    .openapi(listRoute, async (c) => {
      const ws = c.get("member").workspaceId;
      const [list, reads] = await Promise.all([competitors().list(ws), snapshots().lastReads(ws)]);
      return c.json({ competitors: list, reads: reads.map((r) => ({ ...r, source: r.source as Source, readAt: r.readAt.toISOString() })) }, 200);
    })
    .openapi(changesRoute, async (c) => {
      const ws = c.get("member").workspaceId;
      const { id } = c.req.valid("param");
      if (!(await competitors().list(ws)).some((x) => x.id === id)) return c.json({ error: "not_found" }, 404);
      const rows = await snapshots().recentChanges(ws, id);
      const changes = rows.map((r) => ({
        id: r.id,
        source: r.source as Source,
        detail: r.detail as z.infer<typeof ChangeDetail>,
        at: r.createdAt.toISOString(),
        label: r.label as Label | null,
        kind: r.kind,
        sameAs: r.sameAsChangeId,
        reason: r.reason,
        itemId: r.itemId,
      }));
      return c.json({ changes }, 200);
    })
    .openapi(addRoute, async (c) => {
      const m = c.get("member");
      const r = await competitors().add(m.workspaceId, m.userId, c.req.valid("json"));
      return r.ok ? c.json({ competitor: r.competitor, checks: r.checks }, 200) : c.json({ error: r.reason }, status(r.reason));
    })
    .openapi(editRoute, async (c) => {
      const r = await competitors().edit(c.get("member").workspaceId, c.req.valid("param").id, c.req.valid("json"));
      return r.ok ? c.json({ competitor: r.competitor, checks: r.checks }, 200) : c.json({ error: r.reason }, status(r.reason));
    })
    .openapi(removeRoute, async (c) =>
      (await competitors().remove(c.get("member").workspaceId, c.req.valid("param").id)) ? c.json({ ok: true as const }, 200) : c.json({ error: "not_found" }, 404),
    )
    .openapi(checkRoute, async (c) => {
      const checks = await competitors().check(c.get("member").workspaceId, c.req.valid("param").id);
      return checks ? c.json({ checks }, 200) : c.json({ error: "not_found" }, 404);
    });
}
