// SPDX-License-Identifier: AGPL-3.0-only
// Network accounts over HTTP. identity's Workspace middleware has already resolved the caller. Saving a
// Workspace's own app uses the credential routes, which already ask for credential.manage and step-up.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { can, requirePermission, requireStepUp, steppedUp, type MemberEnv } from "../identity/index";
import { WarningShape } from "../items/index";
import { markEstablished, reportRemoved, setLowerLimits, unpauseById } from "./application/account-health";
import { postLinkImage, type Posts } from "./application/posts";
import { CEILING } from "./domain/budget";
import type { Social } from "./application/social";

const ErrorBody = z.object({ error: z.string() }).openapi("SocialError");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const errors = {
  400: json(ErrorBody, "Invalid request"),
  401: json(ErrorBody, "Not signed in"),
  403: json(ErrorBody, "Not allowed, or step-up required"),
  404: json(ErrorBody, "Not found"),
};
const ws = z.object({ workspaceId: z.uuid() });
const one = ws.extend({ credentialId: z.uuid() });
const Field = z.object({ name: z.string(), label: z.string(), optional: z.boolean().optional() });
const Network = z
  .object({
    connection: z.string(),
    label: z.string(),
    accountTypes: z.array(z.string()),
    connect: z.enum(["oauth", "form"]),
    availability: z.enum(["available", "awaiting_approval", "not_built", "not_available"]),
    canConnect: z.boolean(),
    publishes: z.boolean(),
    app: z.enum(["own", "system"]).nullable(),
    fields: z.array(Field).optional(),
    wizard: z
      .object({ consoleUrl: z.string(), scopes: z.array(z.string()), steps: z.array(z.string()), callbackUrl: z.string() })
      .optional(),
  })
  .openapi("SocialNetwork");
const Account = z
  .object({
    id: z.uuid(),
    credentialId: z.uuid(),
    connection: z.string(),
    network: z.string(),
    accountType: z.string(),
    networkId: z.string(),
    name: z.string(),
    status: z.string(),
    ownerUserId: z.uuid().nullable(),
    lastCheckedAt: z.iso.datetime().nullable(),
    warning: z.object({ level: z.enum(["soon", "urgent"]), endsAt: z.iso.datetime() }).nullable(),
    canDo: z.array(z.object({ feature: z.string(), status: z.enum(["available", "coming", "needs_own_app", "reconnect"]) })),
    runBy: z.string().nullable(),
    angle: z.string().nullable(),
    siblings: z.number().int(),
    asksAngle: z.boolean(),
    establishable: z.boolean(),
    health: z.object({
      budget: z.object({ posts: z.number(), replies: z.number(), links: z.number() }),
      used: z.object({ posts: z.number(), links: z.number() }),
      paused: z.object({ at: z.iso.datetime(), reason: z.string(), detail: z.string().nullable() }).nullable(),
    }),
  })
  .openapi("SocialAccount");
const Target = z.object({ id: z.string(), name: z.string(), type: z.string(), added: z.boolean(), needsAngle: z.boolean() }).openapi("SocialTarget");

const read = { middleware: [requirePermission("workspace.read")] };
const networksRoute = createRoute({ method: "get", path: "/api/w/{workspaceId}/social/networks", ...read, request: { params: ws }, responses: { 200: json(z.object({ networks: z.array(Network) }), "Every network and what can be done about it here"), ...errors } });
const accountsRoute = createRoute({ method: "get", path: "/api/w/{workspaceId}/social/accounts", ...read, request: { params: ws }, responses: { 200: json(z.object({ accounts: z.array(Account) }), "Connected targets"), ...errors } });
const targetsRoute = createRoute({ method: "get", path: "/api/w/{workspaceId}/social/credentials/{credentialId}/targets", middleware: [requirePermission("credential.connect")], request: { params: one }, responses: { 200: json(z.object({ targets: z.array(Target) }), "What this login can post to"), ...errors } });
const addRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/social/credentials/{credentialId}/targets",
  middleware: [requirePermission("credential.connect")],
  request: {
    params: one,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            ids: z.array(z.string().min(1).max(200)).min(1).max(200),
            // Targets a person calls established (older, already posting) start above the floor.
            established: z.array(z.string().min(1).max(200)).max(200).optional(),
            angles: z.record(z.string().min(1).max(200), z.string().max(200)).optional(),
          }),
        },
      },
    },
  },
  responses: { 200: json(z.object({ ok: z.literal(true) }), "Added"), ...errors },
});
const disconnectRoute = createRoute({ method: "delete", path: "/api/w/{workspaceId}/social/credentials/{credentialId}", middleware: [requirePermission("credential.connect"), requireStepUp()], request: { params: one }, responses: { 200: json(z.object({ ok: z.literal(true) }), "Disconnected; its history stays"), ...errors } });

const formRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/social/{connection}/form",
  middleware: [requirePermission("credential.connect")],
  request: {
    params: ws.extend({ connection: z.string().regex(/^[a-z0-9_-]{1,40}$/) }),
    // No server field: a form network names its own host, so a customer can't point Direx at one.
    body: { content: { "application/json": { schema: z.strictObject({ username: z.string().min(1).max(320), password: z.string().min(1).max(1000) }) } } },
  },
  responses: {
    201: json(z.object({ credentialId: z.uuid() }), "Signed in and saved; the password is never echoed"),
    422: json(z.object({ error: z.literal("sign_in_failed"), detail: z.string() }), "The network said no; nothing was saved"),
    ...errors,
  },
});

const PostTarget = z.strictObject({ connection: z.string().min(1).max(100), credentialId: z.uuid().nullable(), networkId: z.string().min(1).max(200).nullable(), text: z.string().min(1).max(70_000), followUps: z.array(z.string().min(1).max(70_000)).max(10).optional(), mediaId: z.uuid().nullable().optional(), mediaIds: z.array(z.uuid()).min(1).max(4).optional(), alt: z.array(z.string().max(1000)).max(4).optional() });
const Post = z.object({ id: z.uuid(), itemId: z.uuid(), clipId: z.uuid().nullable(), connection: z.string(), network: z.string(), accountName: z.string().nullable(), mode: z.enum(["publish", "manual"]), text: z.string(), video: z.object({ mediaId: z.uuid(), fileName: z.string().nullable() }).nullable(), images: z.array(z.object({ mediaId: z.uuid(), fileName: z.string().nullable(), alt: z.string() })), url: z.string().nullable(), followUps: z.array(z.object({ status: z.string(), detail: z.string().optional() })), state: z.string(), reason: z.string().nullable(), revision: z.number(), clean: z.boolean(), warnings: z.array(WarningShape), at: z.string().nullable() }).openapi("SocialPost");
const previewRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/social/posts/preview",
  middleware: [requirePermission("item.edit")],
  request: { params: ws, body: { content: { "application/json": { schema: PostTarget } } } },
  responses: {
    200: json(z.object({ connection: z.string(), networkId: z.string().nullable(), ok: z.boolean(), mode: z.enum(["publish", "manual"]).optional(), reason: z.string().optional(), detail: z.string().optional(), text: z.string().optional(), count: z.object({ used: z.number(), limit: z.number() }).optional() }), "What the draft would become"),
    ...errors,
  },
});
const listPostsRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/social/posts",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws, query: z.object({ campaignId: z.uuid(), stepKey: z.string().min(1).max(200) }) },
  responses: {
    200: json(z.object({ posts: z.array(Post) }), "A step's posts"),
    ...errors,
  },
});
const markPostedRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/social/posts/{itemId}/posted",
  middleware: [requirePermission("item.approve")],
  request: { params: ws.extend({ itemId: z.uuid() }), body: { content: { "application/json": { schema: z.strictObject({ url: z.url({ protocol: /^https?$/ }).max(2000).nullable() }) } } } },
  responses: { 200: json(z.object({ ok: z.literal(true) }), "Marked as posted by you"), ...errors },
});

const Refused = json(z.object({ error: z.string(), detail: z.string().optional() }), "Refused: the network's rules, or it is already going out");
// A post a person writes on the Calendar. It waits for approval like any draft.
const writePostRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/social/posts",
  middleware: [requirePermission("item.edit")],
  request: { params: ws, body: { content: { "application/json": { schema: z.strictObject({ connection: z.string().min(1).max(100), credentialId: z.uuid().nullable(), networkId: z.string().min(1).max(200).nullable(), text: z.string().trim().min(1).max(70_000), at: z.iso.datetime({ offset: true }) }) } } } },
  responses: { 201: json(z.object({ itemId: z.uuid(), mode: z.enum(["publish", "manual"]) }), "Made, and waiting for approval"), 409: Refused, ...errors },
});
// A person's own words for a post. Any approval it had is void, so it waits for approval again.
const editPostRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/social/posts/{itemId}",
  middleware: [requirePermission("item.edit")],
  request: { params: ws.extend({ itemId: z.uuid() }), body: { content: { "application/json": { schema: z.strictObject({ text: z.string().trim().min(1).max(70_000) }) } } } },
  responses: { 200: json(z.object({ ok: z.literal(true), count: z.object({ used: z.number(), limit: z.number() }).optional() }), "Saved, and waiting for approval"), 409: Refused, ...errors },
});

// The picture of a post's link card, fetched once by Direx and served from here, so the browser loads
// nothing from the linked site. Only PNG, JPEG, GIF or WebP, as its first bytes said when it was kept.
const linkImageRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/social/posts/{itemId}/link-image",
  ...read,
  request: { params: ws.extend({ itemId: z.uuid() }) },
  responses: { 200: { description: "The image", content: { "image/*": { schema: z.string().openapi({ format: "binary" }) } } }, ...errors },
});

const account = ws.extend({ accountId: z.uuid() });
const done = json(z.object({ ok: z.literal(true) }), "Done");
const removedRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/social/accounts/{accountId}/removed",
  middleware: [requirePermission("item.approve")],
  request: { params: account, body: { content: { "application/json": { schema: z.strictObject({ note: z.string().max(500).nullable() }) } } } },
  responses: { 200: done, ...errors },
});
const unpauseRoute = createRoute({ method: "post", path: "/api/w/{workspaceId}/social/accounts/{accountId}/unpause", middleware: [requirePermission("item.approve")], request: { params: account }, responses: { 200: done, ...errors } });
const aboutRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/social/accounts/{accountId}/about",
  middleware: [requirePermission("credential.connect")],
  request: { params: account, body: { content: { "application/json": { schema: z.strictObject({ runBy: z.string().max(200).nullable(), angle: z.string().max(200).nullable() }) } } } },
  responses: { 200: done, ...errors },
});
const establishedRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/social/accounts/{accountId}/established",
  middleware: [requirePermission("credential.connect")],
  request: { params: account },
  responses: { 200: done, 409: json(z.object({ error: z.string() }), "Only an account still at the floor and not paused can start higher"), ...errors },
});
const limit = (max: number) => z.number().int().min(0).max(max).nullable().optional();
const limitsRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/social/accounts/{accountId}/limits",
  middleware: [requirePermission("item.approve")],
  request: { params: account, body: { content: { "application/json": { schema: z.strictObject({ posts: limit(CEILING.posts), replies: limit(CEILING.replies), links: limit(CEILING.links) }) } } } },
  responses: { 200: done, ...errors },
});

export function socialRoutes({ social, posts }: { social: () => Social; posts?: () => Posts }) {
  const app = new OpenAPIHono<MemberEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    },
  });
  /** A login is its owner's, or a manager's. */
  const allowed = async (c: { get: (k: "member") => { workspaceId: string; userId: string; role: Parameters<typeof can>[0] } }, credentialId: string) => {
    const m = c.get("member");
    const account = (await social().ownerOf(m.workspaceId, credentialId));
    if (account === undefined) return "missing" as const;
    return account === m.userId || can(m.role, "credential.manage") ? null : ("forbidden" as const);
  };
  const iso = (d: Date | null) => d && d.toISOString();
  if (posts) {
    app.openapi(previewRoute, async (c) => c.json(await posts().preview(c.get("member").workspaceId, c.req.valid("json")), 200));
    app.openapi(listPostsRoute, async (c) => {
      const { campaignId, stepKey } = c.req.valid("query");
      const rows = await posts().list(c.get("member").workspaceId, campaignId, stepKey);
      return c.json({ posts: rows.map(({ item, ...r }) => ({ ...r, state: item.state, reason: item.reason, revision: item.revision, clean: item.clean, warnings: item.warnings, at: iso(item.at) })) }, 200);
    });
    app.openapi(linkImageRoute, async (c) => {
    const { workspaceId, itemId } = c.req.valid("param");
    const image = await postLinkImage(workspaceId, itemId);
    if (!image) return c.json({ error: "not_found" }, 404);
    // nosniff and a sandbox, so the bytes are only ever an image, whatever a browser would guess.
    return c.body(new Uint8Array(image.bytes), 200, { "content-type": image.type, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "private, max-age=86400" }) as never;
  });
  app.openapi(writePostRoute, async (c) => {
      const { at, ...t } = c.req.valid("json");
      const r = await posts().write(c.get("member").workspaceId, { ...t, at: new Date(at) }, c.get("member").userId);
      if (r.ok) return c.json({ itemId: r.itemId!, mode: r.mode! }, 201);
      return c.json({ error: r.reason!, ...(r.detail && { detail: r.detail }) }, r.reason === "refused_by_network" ? 409 : 400);
    });
    app.openapi(editPostRoute, async (c) => {
      const r = await posts().edit(c.get("member").workspaceId, c.req.valid("param").itemId, c.req.valid("json").text, c.get("member").userId);
      if (r.ok) return c.json({ ok: true as const, ...(r.count && { count: r.count }) }, 200);
      return c.json({ error: r.reason, ...(r.detail && { detail: r.detail }) }, r.reason === "not_found" ? 404 : 409);
    });
  app.openapi(markPostedRoute, async (c) => {
      const r = await posts().markPosted(c.get("member").workspaceId, c.req.valid("param").itemId, c.req.valid("json").url, c.get("member").userId);
      return r.ok ? c.json({ ok: true as const }, 200) : c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 400);
    });
  }
  const who = (c: { get: (k: "member") => { workspaceId: string } }, accountId: string) => ({ workspaceId: c.get("member").workspaceId, accountId, now: new Date() });
  app.openapi(removedRoute, async (c) => {
    const r = await reportRemoved(who(c, c.req.valid("param").accountId), c.req.valid("json").note);
    return r.ok ? c.json({ ok: true as const }, 200) : c.json({ error: r.reason }, 404);
  });
  app.openapi(unpauseRoute, async (c) => {
    const r = await unpauseById(who(c, c.req.valid("param").accountId));
    return r.ok ? c.json({ ok: true as const }, 200) : c.json({ error: r.reason }, 404);
  });
  app.openapi(limitsRoute, async (c) => {
    const r = await setLowerLimits(who(c, c.req.valid("param").accountId), c.req.valid("json"));
    return r.ok ? c.json({ ok: true as const }, 200) : c.json({ error: r.reason }, 404);
  });
  app.openapi(aboutRoute, async (c) => {
    const r = await social().about(c.get("member").workspaceId, c.req.valid("param").accountId, c.req.valid("json"));
    return r.ok ? c.json({ ok: true as const }, 200) : c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 400);
  });
  app.openapi(establishedRoute, async (c) => {
    const r = await markEstablished(who(c, c.req.valid("param").accountId));
    if (!r.ok) return c.json({ error: r.reason }, 404);
    return r.value ? c.json({ ok: true as const }, 200) : c.json({ error: "not_at_floor" }, 409);
  });
  return app
    .openapi(networksRoute, async (c) => c.json({ networks: await social().networks(c.get("member").workspaceId) }, 200))
    .openapi(accountsRoute, async (c) => {
      const accounts = await social().accounts(c.get("member").workspaceId);
      return c.json({ accounts: accounts.map((a) => ({ ...a, lastCheckedAt: iso(a.lastCheckedAt), warning: a.warning && { level: a.warning.level, endsAt: a.warning.endsAt.toISOString() }, health: { ...a.health, paused: a.health.paused && { ...a.health.paused, at: a.health.paused.at.toISOString() } } })) }, 200);
    })
    .openapi(formRoute, async (c) => {
      const m = c.get("member");
      const r = await social().connectForm(m.workspaceId, m.userId, c.req.valid("param").connection, c.req.valid("json"));
      if (r.ok) return c.json({ credentialId: r.credentialId }, 201);
      if (r.reason === "sign_in_failed") return c.json({ error: r.reason, detail: r.detail }, 422);
      return c.json({ error: r.reason }, r.reason === "unknown_connection" ? 404 : 400);
    })
    .openapi(targetsRoute, async (c) => {
      const { credentialId } = c.req.valid("param");
      const refused = await allowed(c, credentialId);
      if (refused) return c.json({ error: refused }, refused === "missing" ? 404 : 403);
      const targets = await social().targets(c.get("member").workspaceId, credentialId);
      return targets ? c.json({ targets }, 200) : c.json({ error: "not_a_network_login" }, 400);
    })
    .openapi(addRoute, async (c) => {
      const { credentialId } = c.req.valid("param");
      const refused = await allowed(c, credentialId);
      if (refused) return c.json({ error: refused }, refused === "missing" ? 404 : 403);
      const { ids, established, angles } = c.req.valid("json");
      const r = await social().addTargets(c.get("member").workspaceId, credentialId, ids, { ...(established ? { established } : {}), ...(angles ? { angles } : {}) });
      return r.ok ? c.json({ ok: true as const }, 200) : c.json({ error: r.reason }, 400);
    })
    .openapi(disconnectRoute, async (c) => {
      const m = c.get("member");
      const { credentialId } = c.req.valid("param");
      const refused = await allowed(c, credentialId);
      if (refused) return c.json({ error: refused }, refused === "missing" ? 404 : 403);
      const r = await social().disconnect(m.workspaceId, credentialId, m.userId, steppedUp(m));
      return r.ok ? c.json({ ok: true as const }, 200) : c.json({ error: r.reason }, r.reason === "not_a_network_login" ? 400 : 404);
    });
}
