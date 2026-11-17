// SPDX-License-Identifier: AGPL-3.0-only
// A docs tool's pages over HTTP. Listing and reading call the outside service, so they need edit
// rights, as starting the brand reader does.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { requirePermission, type MemberEnv } from "../identity/index";
import type { Docs } from "./application/docs";
import { WriteBackInput, type WriteBackGrants, type WriteBackState } from "./application/grant";
import { MappingInput } from "./application/import";

const ErrorBody = z.object({ error: z.string() }).openapi("DocsError");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const errors = { 400: json(ErrorBody, "Invalid request"), 401: json(ErrorBody, "Not signed in"), 403: json(ErrorBody, "Not allowed"), 404: json(ErrorBody, "Not found"), 409: json(ErrorBody, "Refused, with a named reason") };
const ws = z.object({ workspaceId: z.uuid() });
const page = ws.extend({ pageId: z.string().regex(/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i) });
const DocsPage = z.object({ id: z.string(), title: z.string(), url: z.string().nullable(), editedAt: z.string().nullable() }).openapi("DocsPage");

const statusRoute = createRoute({ method: "get", path: "/api/w/{workspaceId}/docs", middleware: [requirePermission("workspace.read")], request: { params: ws }, responses: { 200: json(z.object({ provider: z.string().nullable(), connected: z.boolean(), imports: z.boolean(), signIn: z.string().nullable() }), "Which docs tool can be connected, whether it is, whether it imports databases, and the connection to start for connecting it by signing in"), ...errors } });
const db = ws.extend({ databaseId: z.string().regex(/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i) });
const src = ws.extend({ sourceId: z.uuid() });
const Column = z.object({ name: z.string(), id: z.string().optional(), type: z.string(), options: z.array(z.string()).nullable(), choices: z.array(z.object({ id: z.string(), name: z.string() })).nullable().optional() }).openapi("DocsColumn");
const Mapping = MappingInput.openapi("DocsMapping");
const databasesRoute = createRoute({ method: "get", path: "/api/w/{workspaceId}/docs/databases", middleware: [requirePermission("item.edit")], request: { params: ws }, responses: { 200: json(z.object({ databases: z.array(z.object({ id: z.string(), title: z.string(), editedAt: z.string().nullable(), sourceId: z.uuid().nullable() })) }), "The databases shared with Direx, each with its import if set up"), ...errors } });
const databaseRoute = createRoute({ method: "get", path: "/api/w/{workspaceId}/docs/databases/{databaseId}", middleware: [requirePermission("item.edit")], request: { params: db }, responses: { 200: json(z.object({ title: z.string(), columns: z.array(Column), sourceId: z.uuid().nullable(), mapping: Mapping.nullable() }), "Its columns and saved mapping"), ...errors } });
const mappingRoute = createRoute({ method: "put", path: "/api/w/{workspaceId}/docs/databases/{databaseId}/mapping", middleware: [requirePermission("item.edit")], request: { params: db, body: { content: { "application/json": { schema: Mapping } } } }, responses: { 200: json(z.object({ sourceId: z.uuid() }), "Saved"), ...errors } });
const RowPlan = z.object({ id: z.string(), title: z.string(), outcome: z.enum(["make", "update", "changed", "same", "skip"]), reason: z.string().optional() }).openapi("DocsRowPlan");
const previewRoute = createRoute({ method: "post", path: "/api/w/{workspaceId}/docs/sources/{sourceId}/preview", middleware: [requirePermission("item.edit")], request: { params: src }, responses: { 200: json(z.object({ rows: z.array(RowPlan), cut: z.boolean() }), "What an import would do to each row; nothing changes"), ...errors } });
const importRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/docs/sources/{sourceId}/import",
  middleware: [requirePermission("item.edit")],
  request: { params: src },
  responses: { 200: json(z.object({ made: z.number(), updated: z.number(), changed: z.number(), skipped: z.array(z.object({ id: z.string(), title: z.string(), reason: z.string() })), cut: z.boolean() }), "Posts made and updated, waiting for approval"), ...errors },
});
const pagesRoute = createRoute({ method: "get", path: "/api/w/{workspaceId}/docs/pages", middleware: [requirePermission("item.edit")], request: { params: ws }, responses: { 200: json(z.object({ pages: z.array(DocsPage), more: z.boolean() }), "The pages shared with Direx, newest edit first"), ...errors } });
const readRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/docs/pages/{pageId}/read",
  middleware: [requirePermission("item.edit")],
  request: { params: page },
  responses: { 200: json(z.object({ runId: z.uuid(), title: z.string(), cut: z.boolean() }), "The brand reader started on the page"), ...errors },
});

export function docsRoutes({ docs }: { docs: () => Docs }) {
  const app = new OpenAPIHono<MemberEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    },
  });
  return app
    .openapi(statusRoute, async (c) => c.json(await docs().status(c.get("member").workspaceId), 200))
    .openapi(pagesRoute, async (c) => {
      const r = await docs().pages(c.get("member").workspaceId);
      return r.ok ? c.json({ pages: r.pages, more: r.more }, 200) : c.json({ error: r.reason }, 409);
    })
    .openapi(databasesRoute, async (c) => {
      const r = await docs().databases(c.get("member").workspaceId);
      return r.ok ? c.json({ databases: r.databases }, 200) : c.json({ error: r.reason }, 409);
    })
    .openapi(databaseRoute, async (c) => {
      const r = await docs().database(c.get("member").workspaceId, c.req.valid("param").databaseId);
      return r.ok ? c.json({ title: r.title, columns: r.columns, sourceId: r.sourceId, mapping: r.mapping }, 200) : c.json({ error: r.reason }, 409);
    })
    .openapi(mappingRoute, async (c) => {
      const m = c.get("member");
      const r = await docs().saveMapping(m.workspaceId, c.req.valid("param").databaseId, c.req.valid("json"), m.userId);
      return r.ok ? c.json({ sourceId: r.sourceId }, 200) : c.json({ error: r.reason }, 409);
    })
    .openapi(previewRoute, async (c) => {
      const r = await docs().preview(c.get("member").workspaceId, c.req.valid("param").sourceId);
      if (r.ok) return c.json({ rows: r.rows, cut: r.cut }, 200);
      return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
    })
    .openapi(importRoute, async (c) => {
      const m = c.get("member");
      const r = await docs().run(m.workspaceId, c.req.valid("param").sourceId, m.userId);
      if (r.ok) return c.json({ made: r.made, updated: r.updated, changed: r.changed, skipped: r.skipped, cut: r.cut }, 200);
      return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
    })
    .openapi(readRoute, async (c) => {
      const m = c.get("member");
      const r = await docs().readForFacts(m.workspaceId, c.req.valid("param").pageId, m.userId);
      return r.ok ? c.json({ runId: r.runId, title: r.title, cut: r.cut }, 200) : c.json({ error: r.reason }, 409);
    });
}

// Status write-back for one imported source (ADR 0025): its mapping and the yes are rule.grant's;
// reading where it stands and stopping it are any member's.
const WriteBackBody = WriteBackInput.openapi("DocsWriteBack");
const Grant = z.object({ id: z.uuid(), answer: z.enum(["yes", "no"]), wordingVersion: z.string(), answeredBy: z.uuid(), answeredAt: z.iso.datetime(), stoppedBy: z.uuid().nullable(), stoppedAt: z.iso.datetime().nullable(), stopReason: z.string().nullable() });
const WriteBackStateBody = z
  .object({
    status: z.enum(["unanswered", "no", "on", "stopped", "wording_changed", "mapping_changed", "granter_lost"]),
    wordingVersion: z.string(),
    wording: z.string(),
    mayAnswer: z.boolean(),
    writeBack: WriteBackBody.nullable(),
    grant: Grant.nullable(),
    // Held and Blocked write-backs, with why; they never go to Needs you.
    writes: z.array(z.object({ rowId: z.string(), itemId: z.uuid(), state: z.enum(["held", "blocked"]), reason: z.string(), detail: z.string().nullable() })),
  })
  .openapi("DocsWriteBackState");
// Read from the database only, never the docs tool, so a Viewer reaches each source's Stop (rule 001).
const sourcesRoute = createRoute({ method: "get", path: "/api/w/{workspaceId}/docs/sources", middleware: [requirePermission("workspace.read")], request: { params: ws }, responses: { 200: json(z.object({ sources: z.array(z.object({ id: z.uuid(), title: z.string(), state: WriteBackStateBody })) }), "Each imported source and where its status write-back stands"), ...errors } });
const wbPath = "/api/w/{workspaceId}/docs/sources/{sourceId}/write-back";
const wbBody = <T extends z.ZodType>(schema: T) => ({ body: { content: { "application/json": { schema } } } });
const writeBackReadRoute = createRoute({ method: "get", path: wbPath, middleware: [requirePermission("workspace.read")], request: { params: src }, responses: { 200: json(WriteBackStateBody, "Where status write-back stands for this source"), ...errors } });
const writeBackPutRoute = createRoute({ method: "put", path: wbPath, middleware: [requirePermission("rule.grant")], request: { params: src, ...wbBody(WriteBackBody) }, responses: { 200: json(WriteBackStateBody, "Saved; a changed mapping stops the yes"), ...errors } });
const grantRoute = createRoute({
  method: "post",
  path: `${wbPath}/grant`,
  middleware: [requirePermission("rule.grant")],
  // No default answer: a request without one is refused, and no answer means no.
  request: { params: src, ...wbBody(z.strictObject({ answer: z.enum(["yes", "no"]), wordingVersion: z.string().max(40) })) },
  responses: { 200: json(WriteBackStateBody, "Answer recorded"), ...errors },
});
const stopRoute = createRoute({
  method: "post",
  path: `${wbPath}/stop`,
  middleware: [requirePermission("workspace.read")],
  request: { params: src, ...wbBody(z.strictObject({ reason: z.string().trim().min(1).max(500) })) },
  responses: { 200: json(z.object({ cancelled: z.number().int(), state: WriteBackStateBody }), "Stopped; write-backs not yet out are cancelled"), ...errors },
});

const shown = (s: WriteBackState) => ({ ...s, grant: s.grant && { ...s.grant, answeredAt: s.grant.answeredAt.toISOString(), stoppedAt: s.grant.stoppedAt?.toISOString() ?? null }, writes: s.writes.map((w) => ({ ...w, state: w.state as "held" | "blocked" })) });
const WB_STATUS = { not_found: 404, stale_wording: 409, no_write_back: 409, already_on: 409, not_on: 409 } as const;

export function docsWriteBackRoutes({ grants }: { grants: () => WriteBackGrants }) {
  const app = new OpenAPIHono<MemberEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    },
  });
  return app
    .openapi(sourcesRoute, async (c) => c.json({ sources: (await grants().list(c.req.valid("param").workspaceId, c.get("member"))).map((s) => ({ ...s, state: shown(s.state) })) }, 200))
    .openapi(writeBackReadRoute, async (c) => {
      const r = await grants().state(c.req.valid("param").workspaceId, c.req.valid("param").sourceId, c.get("member"));
      return r.ok ? c.json(shown(r.state), 200) : c.json({ error: r.reason }, WB_STATUS[r.reason]);
    })
    .openapi(writeBackPutRoute, async (c) => {
      const { workspaceId, sourceId } = c.req.valid("param");
      const saved = await grants().saveWriteBack(workspaceId, sourceId, c.req.valid("json"));
      if (!saved.ok) return c.json({ error: saved.reason }, saved.reason === "not_found" ? 404 : 409);
      const r = await grants().state(workspaceId, sourceId, c.get("member"));
      return r.ok ? c.json(shown(r.state), 200) : c.json({ error: r.reason }, WB_STATUS[r.reason]);
    })
    .openapi(grantRoute, async (c) => {
      const r = await grants().answer(c.req.valid("param").workspaceId, c.req.valid("param").sourceId, c.get("member"), c.req.valid("json"));
      return r.ok ? c.json(shown(r.state), 200) : c.json({ error: r.reason }, WB_STATUS[r.reason]);
    })
    .openapi(stopRoute, async (c) => {
      const r = await grants().stop(c.req.valid("param").workspaceId, c.req.valid("param").sourceId, c.get("member"), c.req.valid("json").reason);
      return r.ok ? c.json({ cancelled: r.cancelled, state: shown(r.state) }, 200) : c.json({ error: r.reason }, WB_STATUS[r.reason]);
    });
}
