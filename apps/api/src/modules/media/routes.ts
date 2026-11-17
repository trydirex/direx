// SPDX-License-Identifier: AGPL-3.0-only
// Upload, read and delete a Workspace's files. The upload body is the raw file, not a form, so it streams.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { requirePermission, type MemberEnv } from "../identity/index";
import type { Media, MediaView } from "./application/media";
import type { Stored } from "./adapters/store";
import { byteRange } from "./domain/range";

const ErrorBody = z.object({ error: z.string() }).openapi("MediaError");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const errors = { 400: json(ErrorBody, "Invalid request"), 401: json(ErrorBody, "Not signed in"), 403: json(ErrorBody, "Not allowed"), 404: json(ErrorBody, "No such file here") };
const ws = z.object({ workspaceId: z.uuid() });
const one = z.object({ workspaceId: z.uuid(), id: z.uuid() });
const MediaView = z
  .object({ id: z.uuid(), kind: z.enum(["source", "clip"]), contentType: z.string(), bytes: z.number().int(), fileName: z.string(), createdAt: z.string() })
  .openapi("Media");
const video = (description: string) => ({ description, content: { "video/*": { schema: z.string().openapi({ format: "binary" }) } } });

const uploadRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/media",
  middleware: [requirePermission("item.edit")],
  description: "The body is the file itself. X-File-Name carries its name, percent-encoded. MP4, MOV and WebM only, up to 2 GB.",
  request: { params: ws, query: z.object({ kind: z.enum(["source", "clip"]) }) },
  responses: {
    201: json(z.object({ media: MediaView }), "Stored"),
    413: json(ErrorBody, "too_large"),
    415: json(ErrorBody, "not_supported: not an MP4, MOV or WebM video, nor a PNG, JPEG, GIF or WebP image"),
    ...errors,
  },
});
const readRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/media/{id}",
  middleware: [requirePermission("workspace.read")],
  request: { params: one },
  responses: {
    200: video("The whole file"),
    206: video("The range asked for"),
    302: { description: "A short-lived link to the file in object storage" },
    416: json(ErrorBody, "The range is past the end of the file"),
    ...errors,
  },
});
const linkRoute = createRoute({
  method: "get",
  path: "/api/media-links/{token}",
  description: "Opens one file for a few minutes with no sign-in, for a plugin publishing an approved post. The token is the proof.",
  request: { params: z.object({ token: z.string().max(200) }) },
  responses: {
    200: video("The whole file"),
    206: video("The range asked for"),
    302: { description: "A short-lived link to the file in object storage" },
    404: json(ErrorBody, "The link is malformed, altered, past its end, or its file is gone"),
    416: json(ErrorBody, "The range is past the end of the file"),
  },
});
const deleteRoute = createRoute({
  method: "delete",
  path: "/api/w/{workspaceId}/media/{id}",
  middleware: [requirePermission("item.edit")],
  request: { params: one },
  responses: { 204: { description: "Deleted; the bytes go at the next sweep" }, ...errors },
});

const notFound = { error: "not_found" };

/** A file in full or the range asked for; object storage answers with its own short-lived link. */
// Typed loosely: each route's own response union is checked by its openapi definition above.
function serve(c: Context, found: { media: MediaView; stored: Stored } | null): Response {
  if (!found) return c.json(notFound, 404);
  const { media, stored } = found;
  if (stored.kind === "url") return c.redirect(stored.url, 302);
  const size = stored.file.size;
  const headers = { "content-type": media.contentType, "accept-ranges": "bytes", "cache-control": "private, max-age=0" };
  const range = byteRange(c.req.header("range"), size);
  if (range === "unsatisfiable") {
    c.header("content-range", `bytes */${size}`);
    return c.json({ error: "range_not_satisfiable" }, 416);
  }
  if (!range) return c.body(stored.file.stream(), 200, { ...headers, "content-length": String(size) });
  const part = stored.file.slice(range.start, range.end + 1);
  return c.body(part.stream(), 206, { ...headers, "content-length": String(part.size), "content-range": `bytes ${range.start}-${range.end}/${size}` });
}

export function mediaRoutes(deps: { media: () => Media }) {
  const app = new OpenAPIHono<MemberEnv>();
  app.openapi(uploadRoute, async (c) => {
    const m = c.get("member");
    const length = c.req.header("content-length");
    const r = await deps.media().upload({
      workspaceId: m.workspaceId,
      userId: m.userId,
      kind: c.req.valid("query").kind,
      fileName: c.req.header("x-file-name"),
      declaredBytes: length === undefined ? undefined : Number(length),
      body: c.req.raw.body,
    });
    if (r.ok) return c.json({ media: { ...r.media, createdAt: r.media.createdAt.toISOString() } }, 201);
    return r.reason === "too_large" ? c.json({ error: r.reason }, 413) : c.json({ error: r.reason }, 415);
  });
  app.openapi(readRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    return serve(c, await deps.media().read(workspaceId, id));
  });
  app.openapi(linkRoute, async (c) => serve(c, await deps.media().readLink(c.req.valid("param").token)));
  app.openapi(deleteRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    return (await deps.media().remove(workspaceId, id)) ? c.body(null, 204) : c.json(notFound, 404);
  });
  return app;
}
