// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { requirePermission, type MemberEnv } from "../identity/index";
import type { Briefs } from "./application/briefs";
import type { Refused, Seo } from "./application/search-console";

const REASONS = ["not_connected", "needs_reconnecting", "no_property", "not_listed", "no_access", "api_disabled", "busy", "failed"] as const;
/** `selfHost` comes with "api_disabled": a self-hosted operator turns the API on in their own Google project. */
const Refusal = z.object({ reason: z.enum(REASONS), selfHost: z.boolean().optional() }).openapi("SearchConsoleRefusal");
const ErrorBody = z.object({ error: z.string(), selfHost: z.boolean().optional() }).openapi("SeoError");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const errors = { 400: json(ErrorBody, "Invalid request"), 401: json(ErrorBody, "Not signed in"), 403: json(ErrorBody, "Not allowed"), 409: json(ErrorBody, "Refused, with a named reason") };
const ws = z.object({ workspaceId: z.uuid() });
const Property = z.object({ siteUrl: z.string(), permissionLevel: z.string() });

const stateRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/seo/search-console",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: {
    200: json(
      z.object({
        connected: z.boolean(),
        /** The chosen property, or null before one is chosen. */
        siteUrl: z.string().nullable(),
        /** The properties a person may choose; null when they could not be read. */
        properties: z.array(Property).nullable(),
        refusal: Refusal.nullable(),
      }),
      "Whether Search Console is connected, the chosen property and the ones to choose from",
    ),
    ...errors,
  },
});
const chooseRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/seo/search-console/property",
  middleware: [requirePermission("workspace.settings")],
  request: { params: ws, body: { content: { "application/json": { schema: z.strictObject({ siteUrl: z.string().min(1).max(2048) }) } } } },
  responses: { 200: json(z.object({ siteUrl: z.string() }), "Saved; it replaces any earlier choice"), ...errors },
});
const summaryRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/seo/search-console/summary",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: {
    200: json(
      z.object({
        siteUrl: z.string(),
        startDate: z.iso.date(),
        endDate: z.iso.date(),
        clicks: z.number(),
        impressions: z.number(),
        position: z.number().nullable().openapi({ description: "Average rank over the 28 days, weighted by impressions; null with none" }),
        daily: z.array(z.object({ date: z.iso.date(), position: z.number() })).openapi({ description: "Each day's average rank in the 28 days, for days the site was shown" }),
        previous: z.object({ startDate: z.iso.date(), endDate: z.iso.date(), clicks: z.number(), impressions: z.number(), position: z.number().nullable() }).nullable(),
      }),
      "Clicks and impressions for the 28 days of data ending 3 days before today, since Search Console runs that far behind, and for the 28 days before those when the data reaches back that far",
    ),
    ...errors,
  },
});
const Ranked = <T extends z.ZodType>(item: T) => z.object({ total: z.number(), top: z.array(item) });
const Window = z.object({ startDate: z.iso.date(), endDate: z.iso.date() });
const candidatesRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/seo/candidates",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: {
    200: json(
      z.object({
        siteUrl: z.string(),
        current: Window,
        /** The 28 days before `current`, which slipping compares against. */
        previous: Window,
        nearPageOne: Ranked(z.object({ query: z.string(), page: z.string(), clicks: z.number(), impressions: z.number(), position: z.number(), positionBefore: z.number().nullable() })),
        slipping: Ranked(z.object({ page: z.string(), query: z.string(), impressionsBefore: z.number(), impressionsNow: z.number() })),
        competing: Ranked(z.object({ query: z.string(), impressions: z.number(), pages: z.array(z.object({ page: z.string(), clicks: z.number(), impressions: z.number(), position: z.number(), positionBefore: z.number().nullable() })) })),
      }),
      "Pages and queries worth a brief, at most 20 of each kind, best first, with how many there are in all",
    ),
    ...errors,
  },
});

const RunNote = z
  .object({
    week: z.iso.date(),
    at: z.string(),
    by: z.enum(["schedule", "person"]),
    started: z.array(z.object({ page: z.string(), query: z.string(), selector: z.enum(["near_page_one", "slipping", "competing"]) })),
    skipped: z.array(z.object({ page: z.string(), reason: z.string() })),
    stopped: z.string().nullable(),
  })
  .openapi("BriefRunNote");
const briefsRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/seo/briefs",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: { 200: json(z.object({ note: RunNote.nullable(), ranThisWeek: z.boolean() }), "The latest Brief run, and whether this week's has happened"), ...errors },
});
const runRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/seo/briefs/run",
  middleware: [requirePermission("workspace.settings")],
  request: { params: ws },
  responses: { 200: json(RunNote, "This week's run: the Briefs being written, the pages skipped and why"), ...errors },
});
const historyRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/seo/briefs/history",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: {
    200: json(
      z.object({
        briefs: z.array(
          z.object({
            itemId: z.uuid(),
            page: z.string(),
            query: z.string(),
            state: z.enum(["draft", "needs_approval", "scheduled", "applied", "cancelled"]),
            createdAt: z.string(),
            appliedAt: z.string().nullable(),
            checkOn: z.iso.date().nullable().openapi({ description: "The day the 28 days of search data after approval are in Search Console" }),
            before: z
              .object({ clicks: z.number(), startDate: z.iso.date(), endDate: z.iso.date() })
              .nullable()
              .openapi({ description: "Clicks for the search on the page over the 28 days that picked the Brief; null for a Brief picked on impressions alone or with no numbers" }),
            after: z.number().nullable().openapi({ description: "Clicks for the search on the page over the 28 days from approval, read live once those days are in Search Console; null before checkOn, past its 16 months, or when it can't be read" }),
          }),
        ),
        writing: z.array(z.object({ page: z.string(), query: z.string() })).openapi({ description: "The page and search of each Brief still being written: its agent run is still going, so it may have no Item yet" }),
      }),
      "Past Briefs, newest first, at most 100, and the Briefs still being written",
    ),
    ...errors,
  },
});
const writeRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/seo/briefs/write",
  middleware: [requirePermission("item.edit")],
  description: "Starts one Brief for a page and search from the current candidates. The Brief waits for approval like the weekly ones; approving it publishes nothing.",
  request: { params: ws, body: { content: { "application/json": { schema: z.strictObject({ page: z.string().min(1).max(2048), query: z.string().min(1).max(400) }) } } } },
  responses: {
    202: json(z.object({ runId: z.uuid() }), "Writing the Brief"),
    ...errors,
    404: json(ErrorBody, "not_a_candidate: the page and search aren't in the current candidates"),
  },
});

const refused = (r: Refused) => ({ error: r.reason, ...(r.selfHost !== undefined && { selfHost: r.selfHost }) });

export function seoRoutes(deps: { seo: () => Seo; briefs?: () => Briefs }) {
  const app = new OpenAPIHono<MemberEnv>();
  app.openapi(stateRoute, async (c) => c.json(await deps.seo().state(c.req.valid("param").workspaceId), 200));
  app.openapi(chooseRoute, async (c) => {
    const r = await deps.seo().choose(c.req.valid("param").workspaceId, c.req.valid("json").siteUrl);
    return r.ok ? c.json({ siteUrl: r.siteUrl }, 200) : c.json(refused(r), 409);
  });
  app.openapi(summaryRoute, async (c) => {
    const r = await deps.seo().summary(c.req.valid("param").workspaceId);
    if (!r.ok) return c.json(refused(r), 409);
    const { ok: _ok, ...summary } = r;
    return c.json(summary, 200);
  });
  app.openapi(candidatesRoute, async (c) => {
    const m = c.get("member");
    const r = await deps.seo().candidates(m.workspaceId, m.workspaceName);
    if (!r.ok) return c.json(refused(r), 409);
    const { ok: _ok, ...candidates } = r;
    return c.json(candidates, 200);
  });
  const briefs = () => {
    if (!deps.briefs) throw new Error("Briefs need the worker's agents, which start with the server");
    return deps.briefs();
  };
  app.openapi(briefsRoute, async (c) => c.json(await briefs().latest(c.req.valid("param").workspaceId), 200));
  app.openapi(historyRoute, async (c) => c.json(await briefs().history(c.req.valid("param").workspaceId), 200));
  app.openapi(writeRoute, async (c) => {
    const m = c.get("member");
    const r = await briefs().writeOne(m.workspaceId, { ...c.req.valid("json"), userId: m.userId });
    if (r.ok) return c.json({ runId: r.run.id }, 202);
    const body = { error: r.reason, ...("selfHost" in r && r.selfHost !== undefined && { selfHost: r.selfHost }) };
    return r.reason === "not_a_candidate" ? c.json(body, 404) : c.json(body, 409);
  });
  app.openapi(runRoute, async (c) => {
    const m = c.get("member");
    const r = await briefs().run(m.workspaceId, { userId: m.userId });
    if (!r.ok) return c.json({ error: r.reason, ...("selfHost" in r && r.selfHost !== undefined && { selfHost: r.selfHost }) }, 409);
    return c.json(r.note, 200);
  });
  return app;
}
