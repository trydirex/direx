// SPDX-License-Identifier: AGPL-3.0-only
// Start a clip run on an uploaded video, and read where it is. There is no screen here; a Campaign
// step starts runs once clips become Items.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { requirePermission, type MemberEnv } from "../identity/index";
import type { Clips, RunView } from "./application/runs";

const ErrorBody = z.object({ error: z.string() }).openapi("ClipsError");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const errors = { 400: json(ErrorBody, "Invalid request"), 401: json(ErrorBody, "Not signed in"), 403: json(ErrorBody, "Not allowed") };
const Moment = z.object({ startMs: z.number().int(), endMs: z.number().int(), title: z.string(), caption: z.string(), citations: z.array(z.string()), measureKey: z.string().nullable(), why: z.string() });
const Run = z
  .object({
    id: z.uuid(),
    sourceMediaId: z.uuid(),
    planId: z.uuid().nullable(),
    state: z.enum(["queued", "transcribing", "picking", "cutting", "done", "failed"]),
    failure: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    dropped: z.array(z.object({ moment: Moment, reason: z.string() })),
    clips: z.array(Moment.extend({ id: z.uuid(), mediaId: z.uuid() })),
  })
  .openapi("ClipRun");

const startRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/clip-runs",
  middleware: [requirePermission("item.edit")],
  description: "Transcribes the video, has an agent pick the moments that back a Fact or a plan measure, and cuts each into a captioned vertical clip.",
  request: { params: z.object({ workspaceId: z.uuid() }), body: { content: { "application/json": { schema: z.object({ mediaId: z.uuid(), planId: z.uuid().optional() }) } } } },
  responses: {
    202: json(z.object({ run: Run }), "Started"),
    404: json(ErrorBody, "not_found: no such video here; unknown_plan: no approved plan with that id"),
    409: json(ErrorBody, "in_progress: this video already has a run going"),
    ...errors,
  },
});
const readRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/clip-runs/{id}",
  middleware: [requirePermission("workspace.read")],
  request: { params: z.object({ workspaceId: z.uuid(), id: z.uuid() }) },
  responses: { 200: json(z.object({ run: Run }), "The run, its clips, and the moments dropped with why"), 404: json(ErrorBody, "No such run here"), ...errors },
});

const wire = (r: RunView) => ({ ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() });

export function clipRoutes(deps: { clips: () => Clips }) {
  const app = new OpenAPIHono<MemberEnv>();
  app.openapi(startRoute, async (c) => {
    const m = c.get("member");
    const body = c.req.valid("json");
    const r = await deps.clips().start(m.workspaceId, { mediaId: body.mediaId, planId: body.planId, userId: m.userId });
    if (!r.ok) return c.json({ error: r.reason }, r.reason === "in_progress" ? 409 : 404);
    return c.json({ run: wire(r.run) }, 202);
  });
  app.openapi(readRoute, async (c) => {
    const m = c.get("member");
    const run = await deps.clips().get(m.workspaceId, c.req.valid("param").id);
    return run ? c.json({ run: wire(run) }, 200) : c.json({ error: "not_found" }, 404);
  });
  return app;
}
