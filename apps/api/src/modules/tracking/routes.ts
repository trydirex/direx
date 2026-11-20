// SPDX-License-Identifier: AGPL-3.0-only
// Tracking domains over HTTP (ADR 0035). identity's Workspace middleware has resolved the caller; only
// Admins and Owners manage domains. The edge's ask is a separate app, served only on an internal port
// that is never published or proxied (rule 006), so it needs no key.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { Hono } from "hono";
import { requirePermission, type MemberEnv } from "../identity/index";
import type { TrackingDomains } from "./application/domains";

const ErrorBody = z.object({ error: z.string() }).openapi("TrackingError");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const errors = { 400: json(ErrorBody, "Invalid request"), 401: json(ErrorBody, "Not signed in"), 403: json(ErrorBody, "Not allowed"), 404: json(ErrorBody, "Not found") };
const ws = z.object({ workspaceId: z.uuid() });
const one = ws.extend({ id: z.uuid() });
const admin = [requirePermission("workspace.settings")];

const Domain = z
  .object({
    id: z.uuid(),
    hostname: z.string(),
    state: z.enum(["pending", "dns_ok", "verified", "stopped"]),
    cnameTarget: z.string().nullable(),
    txtName: z.string(),
    txtValue: z.string(),
    checkedAt: z.iso.datetime().nullable(),
  })
  .openapi("TrackingDomain");

const path = "/api/w/{workspaceId}/tracking/domains";
const listRoute = createRoute({ method: "get", path, middleware: admin, request: { params: ws }, responses: { 200: json(z.object({ domains: z.array(Domain) }), "This Workspace's tracking domains"), ...errors } });
const addRoute = createRoute({
  method: "post",
  path,
  middleware: admin,
  request: { params: ws, body: { content: { "application/json": { schema: z.object({ hostname: z.string().min(1).max(253) }) } } } },
  responses: {
    201: json(z.object({ domain: Domain }), "Added, waiting for its DNS records"),
    ...errors,
    409: json(ErrorBody, "taken: a Workspace on this server already has the hostname"),
    503: json(ErrorBody, "not_configured: this server has no tracking target (DIREX_TRACKING_TARGET)"),
  },
});
const checkRoute = createRoute({
  method: "post",
  path: `${path}/{id}/check`,
  middleware: admin,
  request: { params: one },
  responses: { 200: json(z.object({ result: z.enum(["verified", "dns_ok", "dns_mismatch", "stopped", "not_configured"]) }), "What the check found"), ...errors },
});
const stopRoute = createRoute({ method: "post", path: `${path}/{id}/stop`, middleware: admin, request: { params: one }, responses: { 200: json(z.object({ ok: z.literal(true) }), "Stopped for new links"), ...errors } });
const removeRoute = createRoute({
  method: "delete",
  path: `${path}/{id}`,
  middleware: admin,
  request: { params: one },
  responses: { 200: json(z.object({ ok: z.literal(true) }), "Removed"), ...errors, 409: json(ErrorBody, "in_use: a link or a Campaign uses this domain; stop it instead") },
});

export function trackingRoutes(deps: { domains: () => TrackingDomains }) {
  return new OpenAPIHono<MemberEnv>()
    .openapi(listRoute, async (c) => c.json({ domains: await deps.domains().list(c.req.valid("param").workspaceId) }, 200))
    .openapi(addRoute, async (c) => {
      const r = await deps.domains().add(c.req.valid("param").workspaceId, c.get("member").userId, c.req.valid("json").hostname);
      if (r === "invalid") return c.json({ error: "invalid_hostname" }, 400);
      if (r === "taken") return c.json({ error: "taken" }, 409);
      if (r === "not_configured") return c.json({ error: "not_configured" }, 503);
      return c.json({ domain: r }, 201);
    })
    .openapi(checkRoute, async (c) => {
      const p = c.req.valid("param");
      const result = await deps.domains().check(p.workspaceId, p.id);
      return result ? c.json({ result }, 200) : c.json({ error: "not_found" }, 404);
    })
    .openapi(stopRoute, async (c) => {
      const p = c.req.valid("param");
      return (await deps.domains().stop(p.workspaceId, p.id)) ? c.json({ ok: true as const }, 200) : c.json({ error: "not_found" }, 404);
    })
    .openapi(removeRoute, async (c) => {
      const p = c.req.valid("param");
      const r = await deps.domains().remove(p.workspaceId, p.id);
      if (!r) return c.json({ error: "not_found" }, 404);
      return r === "in_use" ? c.json({ error: "in_use" }, 409) : c.json({ ok: true as const }, 200);
    });
}

/** The edge's on-demand TLS ask: 200 lets it get a certificate for `domain`, 404 refuses. Internal port only. */
export function trackingAskApp(deps: { domains: () => TrackingDomains }) {
  return new Hono().get("/ask", async (c) => ((await deps.domains().allowed(c.req.query("domain") ?? "")) ? c.body(null, 200) : c.body(null, 404)));
}
