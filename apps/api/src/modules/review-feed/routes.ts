// SPDX-License-Identifier: AGPL-3.0-only
// Review feeds over HTTP. identity's Workspace middleware has resolved the caller for the settings
// routes. The .ics link takes no sign-in: its token is the only proof, checked on every read.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { requirePermission, type MemberEnv } from "../identity/index";
import type { ReviewFeeds } from "./application/feeds";

const ErrorBody = z.object({ error: z.string() }).openapi("ReviewFeedError");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { "application/json": { schema } } } });
const errors = { 400: json(ErrorBody, "Invalid request"), 401: json(ErrorBody, "Not signed in"), 403: json(ErrorBody, "Not allowed"), 404: json(ErrorBody, "Not found") };
const ws = z.object({ workspaceId: z.uuid() });
const Ok = z.object({ ok: z.literal(true) });

const isZone = (timeZone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
};

const Settings = z
  .object({
    /** ISO weekdays: 1 is Monday, 7 is Sunday. */
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).refine((d) => new Set(d).size === d.length, "repeated weekday"),
    /** Minutes from local midnight. */
    startMinute: z.number().int().min(0).max(1439),
    lengthMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]),
    timeZone: z.string().min(1).max(64).refine(isZone, "unknown time zone"),
  })
  .openapi("ReviewFeedSettings");

// The stored length is checked by the table, so the view reads it as a plain number.
const FeedView = Settings.extend({ lengthMinutes: z.number().int(), createdAt: z.iso.datetime(), lastFetchedAt: z.iso.datetime().nullable(), fetchCount: z.number().int() }).openapi("ReviewFeed");

const path = "/api/w/{workspaceId}/review-feed";
const readRoute = createRoute({
  method: "get",
  path,
  middleware: [requirePermission("item.approve")],
  request: { params: ws },
  responses: {
    200: json(z.object({ feed: FeedView.nullable(), reachable: z.boolean() }).openapi("ReviewFeedState"), "The caller's feed, if any, and whether calendars outside can reach this Direx"),
    ...errors,
  },
});
const linkRoute = createRoute({
  method: "post",
  path: `${path}/link`,
  middleware: [requirePermission("item.approve")],
  request: { params: ws, ...body(Settings) },
  responses: { 200: json(z.object({ url: z.url() }).openapi("ReviewFeedLink"), "The new link, shown this once; any old link has stopped"), ...errors },
});
const settingsRoute = createRoute({
  method: "put",
  path,
  middleware: [requirePermission("item.approve")],
  request: { params: ws, ...body(Settings) },
  responses: { 200: json(Ok, "Saved"), ...errors },
});
const stopRoute = createRoute({
  method: "delete",
  path,
  middleware: [requirePermission("item.approve")],
  request: { params: ws },
  responses: { 200: json(Ok, "Stopped; the link no longer works"), ...errors },
});

const validFeed = z.object({ workspaceId: z.uuid(), token: z.string().regex(/^[0-9a-f]{64}$/) });

export function reviewFeedRoutes(deps: { feeds: () => ReviewFeeds; reachable: () => boolean }) {
  const app = new OpenAPIHono<MemberEnv>()
    .openapi(readRoute, async (c) => {
      const f = await deps.feeds().read(c.req.valid("param").workspaceId, c.get("member").userId);
      const feed = f && { ...f, createdAt: f.createdAt.toISOString(), lastFetchedAt: f.lastFetchedAt?.toISOString() ?? null };
      return c.json({ feed, reachable: deps.reachable() }, 200);
    })
    .openapi(linkRoute, async (c) => c.json({ url: await deps.feeds().makeLink(c.req.valid("param").workspaceId, c.get("member").userId, c.req.valid("json")) }, 200))
    .openapi(settingsRoute, async (c) => {
      const saved = await deps.feeds().updateSettings(c.req.valid("param").workspaceId, c.get("member").userId, c.req.valid("json"));
      return saved ? c.json({ ok: true as const }, 200) : c.json({ error: "no_feed" }, 404);
    })
    .openapi(stopRoute, async (c) => {
      const stopped = await deps.feeds().stop(c.req.valid("param").workspaceId, c.get("member").userId);
      return stopped ? c.json({ ok: true as const }, 200) : c.json({ error: "no_feed" }, 404);
    });

  app.get("/api/feeds/review/:workspaceId/:file", async (c) => {
    const file = c.req.param("file");
    const p = validFeed.safeParse({ workspaceId: c.req.param("workspaceId"), token: file.endsWith(".ics") ? file.slice(0, -4) : "" });
    const ics = p.success ? await deps.feeds().icsFor(p.data.workspaceId, p.data.token) : null;
    if (!ics) return c.text("Not found", 404);
    return c.body(ics, 200, { "content-type": "text/calendar; charset=utf-8", "cache-control": "private, max-age=900", "x-content-type-options": "nosniff" });
  });
  return app;
}
