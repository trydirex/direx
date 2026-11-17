// SPDX-License-Identifier: AGPL-3.0-only
// An Owner starts a Workspace export, lists the latest, and downloads one for 24 hours after it is
// ready. Outside /api/w/, so a deleted Workspace's Owner still reaches them until the purge.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { requireMember, requirePermission, type Auth, type MemberEnv } from "../identity/index";
import type { Exports, ExportView } from "./application/exports";

const ErrorBody = z.object({ error: z.string() }).openapi("ExportError");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const errors = { 401: json(ErrorBody, "Not signed in"), 403: json(ErrorBody, "Not an Owner"), 404: json(ErrorBody, "No such Workspace or export here") };
const ws = z.object({ workspaceId: z.uuid() });
const one = z.object({ workspaceId: z.uuid(), id: z.uuid() });
const Export = z
  .object({
    id: z.uuid(),
    state: z.enum(["building", "ready", "failed", "expired"]),
    requestedAt: z.string(),
    readyAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    bytes: z.number().int().nullable(),
  })
  .openapi("WorkspaceExport");

export function exportRoutes(deps: { auth: () => Auth; exports: () => Exports }) {
  const owner = [requireMember(deps.auth, { deleted: true }), requirePermission("workspace.export")];
  const startRoute = createRoute({
    method: "post",
    path: "/api/exports/{workspaceId}",
    middleware: owner,
    description: "Starts building a ZIP of everything the Workspace holds: a JSON Lines file per table and its media files, without credential secrets or keys. Owners only; works for a deleted Workspace until it is purged.",
    request: { params: ws },
    responses: { 202: json(z.object({ export: Export }), "Building"), 409: json(ErrorBody, "export_running: one is already being built"), ...errors },
  });
  const listRoute = createRoute({
    method: "get",
    path: "/api/exports/{workspaceId}",
    middleware: owner,
    request: { params: ws },
    responses: { 200: json(z.object({ exports: z.array(Export) }), "The latest exports, newest first"), ...errors },
  });
  const downloadRoute = createRoute({
    method: "get",
    path: "/api/exports/{workspaceId}/{id}",
    middleware: owner,
    request: { params: one },
    responses: {
      200: { description: "The ZIP", content: { "application/zip": { schema: z.string().openapi({ format: "binary" }) } } },
      302: { description: "A short-lived link to the ZIP in object storage" },
      ...errors,
    },
  });

  const out = (e: ExportView) => ({ ...e, requestedAt: e.requestedAt.toISOString(), readyAt: e.readyAt?.toISOString() ?? null, expiresAt: e.expiresAt?.toISOString() ?? null });
  const app = new OpenAPIHono<MemberEnv>();
  app.openapi(startRoute, async (c) => {
    const m = c.get("member");
    const r = await deps.exports().start(m.workspaceId, m.userId);
    return r.ok ? c.json({ export: out(r.export) }, 202) : c.json({ error: r.reason }, 409);
  });
  app.openapi(listRoute, async (c) => c.json({ exports: (await deps.exports().list(c.get("member").workspaceId)).map(out) }, 200));
  app.openapi(downloadRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const stored = await deps.exports().download(workspaceId, id);
    if (!stored) return c.json({ error: "not_found" }, 404);
    if (stored.kind === "url") return c.redirect(stored.url, 302);
    const day = new Date().toISOString().slice(0, 10);
    return c.body(stored.file.stream(), 200, {
      "content-type": "application/zip",
      "content-length": String(stored.file.size),
      "content-disposition": `attachment; filename="direx-export-${day}.zip"`,
      "cache-control": "private, no-store",
    });
  });
  return app;
}
