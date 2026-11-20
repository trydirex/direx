// SPDX-License-Identifier: AGPL-3.0-only
// The vault over HTTP. identity's Workspace middleware has already resolved the caller on
// /api/w/:workspaceId/*; who may touch a credential depends on its scope and owner, so
// those checks run in the handler. No response carries a value.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import { can, readSession, requirePermission, requireStepUp, steppedUp, type Auth, type Member, type MemberEnv } from "../identity/index";
import { STATE_COOKIE, STATE_TTL_MS } from "./adapters/cookie";
import { linkWorkspace } from "./domain/connect-link";
import { KINDS } from "./application/kinds";
import type { CredentialMeta, Vault } from "./application/secrets";

const ErrorBody = z.object({ error: z.string() }).openapi("Error");
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { "application/json": { schema } } } });
/** Where a Mailbox's header check stands right after Connect or Check again. */
const MailboxCheck = z.object({ state: z.string(), reason: z.string().nullable() }).openapi("MailboxCheckStart");
const errors = {
  400: json(ErrorBody, "Invalid request"),
  401: json(ErrorBody, "Not signed in"),
  403: json(ErrorBody, "Not allowed, or step-up required"),
  404: json(ErrorBody, "Not found"),
  409: json(ErrorBody, "Duplicate key or stale version"),
};
const ws = z.object({ workspaceId: z.uuid() });
const one = ws.extend({ id: z.uuid() });
const Scope = z.enum(["workspace", "user"]);
const Credential = z
  .object({
    id: z.uuid(),
    scope: Scope,
    ownerUserId: z.uuid().nullable(),
    kind: z.enum(KINDS),
    key: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    connection: z.string().nullable(),
    meta: z.record(z.string(), z.unknown()),
    status: z.enum(["active", "needs_reauth", "revoked"]),
    version: z.number(),
    expiresAt: z.iso.datetime().nullable(),
    createdBy: z.uuid(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
    lastRotatedAt: z.iso.datetime().nullable(),
  })
  .openapi("Credential");
const AccessEvent = z
  .object({
    consumer: z.string(),
    outcome: z.string(),
    errorCode: z.string().nullable(),
    actionId: z.uuid().nullable(),
    actorUserId: z.uuid().nullable(),
    at: z.iso.datetime(),
  })
  .openapi("CredentialAccessEvent");
const Ok = z.object({ ok: z.literal(true) }).openapi("Ok");

const STATUS = {
  forbidden: 403,
  step_up_required: 403,
  missing: 404,
  unknown_connection: 404,
  duplicate_key: 409,
  stale_version: 409,
  unknown_kind: 400,
  bad_value: 400,
  bad_meta: 400,
  oauth2_needs_connect: 400,
} as const;

const route = <R extends Parameters<typeof createRoute>[0]>(r: R) => createRoute(r);

const MailboxProvider = z
  .object({
    connection: z.string(),
    label: z.string(),
    connect: z.enum(["oauth", "form"]),
    fields: z.array(z.object({ name: z.string(), label: z.string(), optional: z.boolean().optional() })).optional(),
    presets: z.array(z.object({ label: z.string(), values: z.record(z.string(), z.string()) })).optional(),
  })
  .openapi("MailboxProvider");
const providersRoute = route({
  method: "get",
  path: "/api/w/{workspaceId}/mailbox-providers",
  request: { params: ws, query: z.object({ purpose: z.enum(["connect", "existing"]).optional() }) },
  responses: { 200: json(z.object({ providers: z.array(MailboxProvider) }), "The ways to connect a Mailbox here"), ...errors },
});
const connectFormRoute = route({
  method: "post",
  path: "/api/w/{workspaceId}/mailboxes/{connection}",
  middleware: [requirePermission("credential.connect")],
  request: {
    params: ws.extend({ connection: z.string().regex(/^[a-z0-9_-]{1,40}$/) }),
    ...body(
      z.object({
        username: z.string().min(1).max(320),
        password: z.string().min(1).max(1000),
        settings: z.record(z.string(), z.string().max(300)),
        /** The version of the probe wording the person saw; connecting approves that probe. */
        probeWording: z.string().max(40).optional(),
      }),
    ),
  },
  responses: {
    201: json(z.object({ credential: Credential, hasSent: z.boolean().nullable(), check: MailboxCheck.nullable() }), "Signed in and saved; the password is never echoed"),
    422: json(z.object({ error: z.literal("sign_in_failed"), detail: z.string() }), "The mail server said no; nothing was saved"),
    ...errors,
  },
});
const checkAgainRoute = route({
  method: "post",
  path: "/api/w/{workspaceId}/mailboxes/{credentialId}/check",
  middleware: [requirePermission("credential.connect")],
  request: { params: ws.extend({ credentialId: z.uuid() }), ...body(z.object({ probeWording: z.string().max(40) })) },
  responses: {
    200: json(z.object({ check: MailboxCheck }), "A probe is on its way, or the reason there is none"),
    429: json(ErrorBody, "Five checks a day, or the provider refused one in the last day"),
    ...errors,
  },
});


const KeyService = z.object({ connection: z.string(), name: z.string(), canCheck: z.boolean() }).openapi("KeyService");
const KeyCheck = z
  .union([
    z.object({ remainingCredits: z.number().int().min(0) }),
    z.object({ listName: z.string(), subscriberCount: z.number().int().min(0), canSend: z.boolean() }),
  ])
  .openapi("KeyCheck");
export type KeyCheckResult = z.infer<typeof KeyCheck>;
// A first-party key connection, or an installed plugin's, stored under its id as `<plugin id>:<key>` (ADR 0026 rule 008).
const keyConnection = ws.extend({ connection: z.string().regex(/^(?:[a-z0-9]+(?:\.[a-z0-9-]+)+:)?[a-z0-9_-]{1,40}$/) });
const keyServicesRoute = route({
  method: "get",
  path: "/api/w/{workspaceId}/key-services",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: { 200: json(z.object({ services: z.array(KeyService) }), "The services a Workspace connects with an API key"), ...errors },
});
const TypedKey = z.object({ key: z.string().min(1).max(1000) });
const CheckFailed = json(z.object({ error: z.literal("check_failed") }), "The service refused the key or could not be reached; nothing was saved");
const connectKeyRoute = route({
  method: "post",
  path: "/api/w/{workspaceId}/key-services/{connection}",
  request: { params: keyConnection, ...body(TypedKey) },
  responses: { 201: json(z.object({ credential: Credential }), "Checked where the service can be asked, then stored for the Workspace; the key is never echoed"), 422: CheckFailed, ...errors },
});
const replaceKeyRoute = route({
  method: "put",
  path: "/api/w/{workspaceId}/key-services/{connection}",
  request: { params: keyConnection, ...body(TypedKey) },
  responses: { 200: json(z.object({ credential: Credential }), "Checked where the service can be asked, then replaced; the key is never echoed"), 422: CheckFailed, ...errors },
});
const checkKeyRoute = route({
  method: "post",
  path: "/api/w/{workspaceId}/key-services/{connection}/check",
  middleware: [requirePermission("credential.manage")],
  request: { params: keyConnection },
  responses: {
    200: json(KeyCheck, "The service took the stored key: a verification service's credits, or a newsletter list's name and size"),
    422: json(z.object({ error: z.literal("check_failed") }), "The service refused the stored key or could not be reached"),
    ...errors,
  },
});

const startRoute = route({
  method: "post",
  path: "/api/w/{workspaceId}/connections/{connection}/start",
  middleware: [requirePermission("credential.connect")],
  request: { params: ws.extend({ connection: z.string().regex(/^[a-z0-9_-]{1,40}$/) }) },
  responses: { 200: json(z.object({ url: z.url() }), "Open this URL to give consent"), ...errors },
});
const issueLinkRoute = route({
  method: "post",
  path: "/api/w/{workspaceId}/connections/{connection}/links",
  middleware: [requirePermission("credential.connect"), requireStepUp()],
  request: { params: ws.extend({ connection: z.string().regex(/^[a-z0-9_-]{1,40}$/) }) },
  responses: {
    201: json(z.object({ url: z.url(), expiresAt: z.iso.datetime() }), "Open this link where the other account is signed in; it works once, for 15 minutes"),
    429: json(ErrorBody, "Five links for this network are still open"),
    ...errors,
  },
});
const ConnectLink = z
  .object({
    id: z.uuid(),
    connection: z.string(),
    status: z.enum(["open", "claimed", "connected", "failed", "expired"]),
    expiresAt: z.iso.datetime(),
    credentialId: z.uuid().nullable(),
    accountName: z.string().nullable(),
  })
  .openapi("ConnectLink");
const linksRoute = route({
  method: "get",
  path: "/api/w/{workspaceId}/connect-links",
  middleware: [requirePermission("credential.connect")],
  request: { params: ws },
  responses: { 200: json(z.object({ links: z.array(ConnectLink) }), "The person's own links from the last day"), ...errors },
});
const callbackRoute = route({
  method: "get",
  path: "/api/connections/callback",
  request: {
    query: z.object({ state: z.string().max(200).optional(), code: z.string().max(2000).optional(), error: z.string().max(200).optional() }),
  },
  responses: {
    200: { description: "A connect from a link worked; a page says to finish on the device that made it" },
    302: { description: "Back to the web app" },
    400: { description: "A connect from a link did nothing" },
    401: json(ErrorBody, "Not signed in"),
  },
});
const listRoute = route({
  method: "get",
  path: "/api/w/{workspaceId}/credentials",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: { 200: json(z.object({ credentials: z.array(Credential) }), "Every live credential, metadata only"), ...errors },
});
const createCredentialRoute = route({
  method: "post",
  path: "/api/w/{workspaceId}/credentials",
  request: {
    params: ws,
    ...body(
      z.object({
        scope: Scope,
        kind: z.enum(KINDS),
        key: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
        name: z.string().min(1).max(200),
        description: z.string().max(2000).nullish(),
        meta: z.record(z.string(), z.unknown()).default({}),
        value: z.unknown(),
      }),
    ),
  },
  responses: { 201: json(z.object({ credential: Credential }), "Stored; the value is never echoed"), ...errors },
});
const rotateRoute = route({
  method: "put",
  path: "/api/w/{workspaceId}/credentials/{id}/value",
  request: { params: one, ...body(z.object({ version: z.number().int().positive(), value: z.unknown() })) },
  responses: { 200: json(z.object({ credential: Credential }), "Rotated"), ...errors },
});
const deleteRoute = route({
  method: "delete",
  path: "/api/w/{workspaceId}/credentials/{id}",
  request: { params: one },
  responses: { 200: json(Ok, "Deleted; its access history stays"), ...errors },
});
const eventsRoute = route({
  method: "get",
  path: "/api/w/{workspaceId}/credentials/{id}/events",
  request: { params: one },
  responses: { 200: json(z.object({ events: z.array(AccessEvent) }), "The latest 100 uses, newest first"), ...errors },
});

type Refused = "forbidden" | "step_up_required" | null;

/**
 * A workspace secret needs credential.manage and step-up. A user secret is its owner's;
 * `othersToo` lets credential.manage act on someone else's (delete, history).
 */
function mayTouch(m: Member, c: { scope: string; ownerUserId: string | null }, othersToo: boolean): Refused {
  if (c.scope === "workspace") {
    if (!can(m.role, "credential.manage")) return "forbidden";
    return steppedUp(m) ? null : "step_up_required";
  }
  if (c.ownerUserId === m.userId) return can(m.role, "credential.connect") ? null : "forbidden";
  return othersToo && can(m.role, "credential.manage") ? null : "forbidden";
}

const iso = (d: Date | null) => d && d.toISOString();
function toJson(c: CredentialMeta) {
  return {
    id: c.id,
    scope: c.scope as z.infer<typeof Scope>,
    ownerUserId: c.ownerUserId,
    kind: c.kind as (typeof KINDS)[number],
    key: c.key,
    name: c.name,
    description: c.description,
    connection: c.connection,
    meta: c.meta as Record<string, unknown>,
    status: c.status as "active" | "needs_reauth" | "revoked",
    version: c.version,
    expiresAt: iso(c.expiresAt),
    // Only the system Workspace has a null here, and it has no members to reach this route.
    createdBy: c.createdBy!,
    createdAt: iso(c.createdAt)!,
    updatedAt: iso(c.updatedAt)!,
    lastUsedAt: iso(c.lastUsedAt),
    lastRotatedAt: iso(c.lastRotatedAt),
  };
}

/** Signs in with a typed credential without storing it. Throws the provider's reason. */
export type CheckMailbox = (workspaceId: string, connection: string, credential: { username: string; password: string; settings: Record<string, string> }) => Promise<{ emailAddress: string; hasSent?: boolean }>;
export type ProbeStart = { ok: true; check: { state: string; reason: string | null } } | { ok: false; reason: string };
export type MailboxConnect = {
  /** Providers currently available for new connections. */
  providers: () => readonly z.infer<typeof MailboxProvider>[];
  /** Providers this deployment recognizes for existing Mailboxes, regardless of connect configuration. */
  eligibleProviders: () => readonly z.infer<typeof MailboxProvider>[];
  check: CheckMailbox;
  /** Sends the Mailbox's header probe, approved by this member, on the wording version they saw. */
  probe?: (workspaceId: string, credentialId: string, member: Member, wordingVersion: string) => Promise<ProbeStart>;
  /** The probe wording the form must show; a request naming any other version is refused. */
  probeWordingVersion?: string;
};
/** Services connected by a pasted API key, from the plugins' manifests. */
export type KeyConnect = {
  services: () => readonly { connection: string; name: string; canCheck: boolean }[];
  /** Asks the service about a key, stored (by credential id) or just typed. Throws when it refuses the key. */
  check: (workspaceId: string, connection: string, key: { credentialId: string } | { typed: string }) => Promise<KeyCheckResult>;
  /** Called after a key is stored or replaced, such as to read a newsletter list straight away. */
  connected?: (workspaceId: string, connection: string, credentialId: string) => Promise<void>;
};
export type CredentialRouteDeps = {
  auth: () => Auth;
  vault: () => Vault;
  baseURL: () => string;
  mailboxes?: MailboxConnect;
  keys?: KeyConnect;
  /** The web page a connect attempt comes back to. Default: credentials. */
  landingPage?: (connection: string | null) => string;
  /** The name of a network a connect link may be made for; undefined for every other connection. */
  linkNetwork?: (connection: string) => string | undefined;
};

/** The pages a connect link shows. They load nothing, and the address bar's token never leaves in a Referer. */
const LINK_HEADERS = { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };
const linkPage = (body: ReturnType<typeof html>) =>
  html`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect an account to Direx</title>${body}`;
const DEAD_LINK = linkPage(html`<p>This link no longer works. Make a new one in Direx.</p>`);

export function credentialRoutes({ auth, vault, baseURL, mailboxes, keys, landingPage, linkNetwork }: CredentialRouteDeps) {
  const keyService = (connection: string) => keys?.services().find((s) => s.connection === connection);
  /** The key is already stored, so a failure here is logged, never turned into a failed connect. */
  async function keyConnected(workspaceId: string, connection: string, credentialId: string) {
    try {
      await keys?.connected?.(workspaceId, connection, credentialId);
    } catch (e) {
      console.error(`credentials: after connecting ${connection}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  /** False when the service refused a typed key; a service with nothing to ask takes any key. */
  async function typedKeyWorks(workspaceId: string, service: { connection: string; canCheck: boolean }, typed: string) {
    if (!keys || !service.canCheck) return true;
    try {
      await keys.check(workspaceId, service.connection, { typed });
      return true;
    } catch {
      // The service's own words could repeat the key, so the reason is dropped.
      return false;
    }
  }
  const app = new OpenAPIHono<MemberEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
      }
    },
  });

  // Outside the chain below, which has grown past what TypeScript can type as one expression.
  app.openapi(issueLinkRoute, async (c) => {
    const m = c.get("member");
    const { connection } = c.req.valid("param");
    if (!linkNetwork?.(connection)) return c.json({ error: "unknown_connection" }, 404);
    const r = await vault().issueLink({ workspaceId: m.workspaceId, userId: m.userId, connection });
    if (!r.ok) return r.reason === "too_many_links" ? c.json({ error: r.reason }, 429) : c.json({ error: r.reason }, 404);
    return c.json({ url: r.url, expiresAt: r.expiresAt.toISOString() }, 201);
  });
  app.openapi(linksRoute, async (c) => {
    const m = c.get("member");
    const links = await vault().links(m.workspaceId, m.userId);
    return c.json({ links: links.map((l) => ({ ...l, expiresAt: l.expiresAt.toISOString() })) }, 200);
  });

  // Public: the person opening a link has no Direx session. A GET only shows the page, because chat
  // apps and scanners follow links; the POST claims it.
  app.get("/api/connect/:workspaceId/:token", async (c) => {
    const link = await vault().openLink(c.req.param("workspaceId"), c.req.param("token"));
    const network = link && linkNetwork?.(link.connection);
    if (!link || !network) return c.html(DEAD_LINK, 404, LINK_HEADERS);
    return c.html(
      linkPage(html`<form method="post">
        <p>Connect an account on ${network} to ${link.workspaceName}, for ${link.issuerEmail}.</p>
        <p>Only continue if you made this link. ${network} will ask you to sign in or confirm the account.</p>
        <button>Continue to ${network}</button>
      </form>`),
      200,
      LINK_HEADERS,
    );
  });
  app.post("/api/connect/:workspaceId/:token", async (c) => {
    const r = await vault().claimLink(c.req.param("workspaceId"), c.req.param("token"));
    if (!r) return c.html(DEAD_LINK, 404, LINK_HEADERS);
    return c.redirect(r.url, 302);
  });

  return app
    .openapi(providersRoute, (c) => {
      const eligible = c.req.valid("query").purpose === "existing" ? mailboxes?.eligibleProviders() : mailboxes?.providers();
      const providers = (eligible ?? []).map(({ connection, label, connect, fields, presets }) => ({ connection, label, connect, fields, presets }));
      return c.json({ providers }, 200);
    })
    .openapi(connectFormRoute, async (c) => {
      const m = c.get("member");
      const { connection } = c.req.valid("param");
      const provider = mailboxes?.providers().find((p) => p.connection === connection && p.connect === "form");
      if (!mailboxes || !provider) return c.json({ error: "unknown_connection" }, 404);
      const { username, password, settings, probeWording } = c.req.valid("json");
      if (mailboxes.probe && probeWording !== mailboxes.probeWordingVersion) return c.json({ error: "stale_wording" }, 409);
      let checked: Awaited<ReturnType<CheckMailbox>>;
      try {
        checked = await mailboxes.check(m.workspaceId, connection, { username, password, settings });
      } catch (e) {
        return c.json({ error: "sign_in_failed" as const, detail: (e as Error).message }, 422);
      }
      const r = await vault().create({
        workspaceId: m.workspaceId,
        actorUserId: m.userId,
        scope: "user",
        kind: "basic",
        connection,
        key: checked.emailAddress,
        name: checked.emailAddress,
        meta: { ...settings, username },
        value: { password },
      });
      if (!r.ok) return c.json({ error: r.reason }, STATUS[r.reason]);
      const started = mailboxes.probe ? await mailboxes.probe(m.workspaceId, r.credential.id, m, probeWording!) : null;
      return c.json({ credential: toJson(r.credential), hasSent: checked.hasSent ?? null, check: started?.ok ? started.check : null }, 201);
    })
    .openapi(checkAgainRoute, async (c) => {
      const m = c.get("member");
      const { credentialId } = c.req.valid("param");
      const found = await vault().find(m.workspaceId, credentialId);
      if (!found) return c.json({ error: "missing" }, 404);
      const refused = mayTouch(m, found, true);
      if (refused) return c.json({ error: refused }, STATUS[refused]);
      if (!mailboxes?.probe || !mailboxes.eligibleProviders().some((p) => p.connection === found.connection)) return c.json({ error: "not_a_mailbox" }, 400);
      const started = await mailboxes.probe(m.workspaceId, credentialId, m, c.req.valid("json").probeWording);
      if (started.ok) return c.json({ check: started.check }, 200);
      if (started.reason === "stale_wording") return c.json({ error: started.reason }, 409);
      if (started.reason === "mailbox_not_found") return c.json({ error: "missing" }, 404);
      return c.json({ error: started.reason }, 429);
    })
    .openapi(keyServicesRoute, (c) => {
      const services = (keys?.services() ?? []).map(({ connection, name, canCheck }) => ({ connection, name, canCheck }));
      return c.json({ services }, 200);
    })
    .openapi(connectKeyRoute, async (c) => {
      const m = c.get("member");
      const { connection } = c.req.valid("param");
      // Every Campaign in the Workspace uses this key, so it is a workspace secret.
      const refused = mayTouch(m, { scope: "workspace", ownerUserId: null }, false);
      if (refused) return c.json({ error: refused }, STATUS[refused]);
      const service = keyService(connection);
      if (!service) return c.json({ error: "unknown_connection" }, 404);
      const { key } = c.req.valid("json");
      if (!(await typedKeyWorks(m.workspaceId, service, key))) return c.json({ error: "check_failed" as const }, 422);
      const r = await vault().create({
        workspaceId: m.workspaceId,
        actorUserId: m.userId,
        scope: "workspace",
        kind: "api_key",
        connection,
        // One key per service: a second connect is a duplicate, and replacing goes through rotate.
        key: `api_key:${connection}`,
        name: service.name,
        meta: {},
        value: { key },
      });
      if (r.ok) await keyConnected(m.workspaceId, connection, r.credential.id);
      return r.ok ? c.json({ credential: toJson(r.credential) }, 201) : c.json({ error: r.reason }, STATUS[r.reason]);
    })
    .openapi(replaceKeyRoute, async (c) => {
      const m = c.get("member");
      const { connection } = c.req.valid("param");
      const refused = mayTouch(m, { scope: "workspace", ownerUserId: null }, false);
      if (refused) return c.json({ error: refused }, STATUS[refused]);
      const service = keyService(connection);
      if (!service) return c.json({ error: "unknown_connection" }, 404);
      const stored = (await vault().list(m.workspaceId)).find((x) => x.scope === "workspace" && x.connection === connection);
      if (!stored) return c.json({ error: "missing" }, 404);
      const { key } = c.req.valid("json");
      if (!(await typedKeyWorks(m.workspaceId, service, key))) return c.json({ error: "check_failed" as const }, 422);
      const r = await vault().rotate({ workspaceId: m.workspaceId, id: stored.id, version: stored.version, value: { key }, actorUserId: m.userId });
      if (r.ok) await keyConnected(m.workspaceId, connection, stored.id);
      return r.ok ? c.json({ credential: toJson(r.credential) }, 200) : c.json({ error: r.reason }, STATUS[r.reason]);
    })
    .openapi(checkKeyRoute, async (c) => {
      const m = c.get("member");
      const { connection } = c.req.valid("param");
      const service = keyService(connection);
      if (!keys || !service?.canCheck) return c.json({ error: "unknown_connection" }, 404);
      const stored = (await vault().list(m.workspaceId)).find((x) => x.scope === "workspace" && x.connection === connection && x.status === "active");
      if (!stored) return c.json({ error: "missing" }, 404);
      try {
        return c.json(await keys.check(m.workspaceId, connection, { credentialId: stored.id }), 200);
      } catch {
        // The service's own words could repeat the key, so the reason stays out of the answer.
        return c.json({ error: "check_failed" as const }, 422);
      }
    })
    .openapi(startRoute, async (c) => {
      const m = c.get("member");
      const r = await vault().start({ workspaceId: m.workspaceId, userId: m.userId, connection: c.req.valid("param").connection });
      if (!r.ok) return c.json({ error: r.reason }, STATUS[r.reason]);
      // Lax, so the cookie comes back on the provider's top-level redirect to the callback.
      setCookie(c, STATE_COOKIE, r.cookie, {
        httpOnly: true,
        secure: baseURL().startsWith("https:"),
        sameSite: "Lax",
        path: "/api/connections",
        maxAge: STATE_TTL_MS / 1000,
      });
      return c.json({ url: r.url }, 200);
    })
    .openapi(callbackRoute, async (c) => {
      const cookie = getCookie(c, STATE_COOKIE);
      // A connect started from a link comes back with no session and no cookie; its state names the link.
      const query = c.req.valid("query");
      if (!cookie && linkWorkspace(query.state)) {
        const r = await vault().linkCallback(query);
        const page = r.ok
          ? linkPage(html`<p>Connected ${r.credential.name}. Finish on the device you made the link on.</p>`)
          : r.reason === "denied"
            ? linkPage(html`<p>Nothing was connected. Make a new link in Direx to try again.</p>`)
            : DEAD_LINK;
        return c.html(page, r.ok ? 200 : 400, LINK_HEADERS);
      }
      const s = await readSession(auth, c);
      if (!s) return c.json({ error: "not_signed_in" }, 401);
      const page = landingPage?.(vault().connectionOf(cookie)) ?? "credentials";
      const r = await vault().callback({ ...c.req.valid("query"), cookie, sessionUserId: s.user.id });
      deleteCookie(c, STATE_COOKIE, { path: "/api/connections" });
      return r.ok
        ? c.redirect(`${baseURL()}/?workspace=${r.workspaceId}&page=${page}&connected=${r.credential.id}`, 302)
        : c.redirect(`${baseURL()}/?page=${page}&connect_error=${r.reason}`, 302);
    })
    .openapi(listRoute, async (c) => {
      return c.json({ credentials: (await vault().list(c.get("member").workspaceId)).map(toJson) }, 200);
    })
    .openapi(createCredentialRoute, async (c) => {
      const m = c.get("member");
      const input = c.req.valid("json");
      const refused = mayTouch(m, { scope: input.scope, ownerUserId: m.userId }, false);
      if (refused) return c.json({ error: refused }, STATUS[refused]);
      const r = await vault().create({ ...input, workspaceId: m.workspaceId, actorUserId: m.userId });
      return r.ok ? c.json({ credential: toJson(r.credential) }, 201) : c.json({ error: r.reason }, STATUS[r.reason]);
    })
    .openapi(rotateRoute, async (c) => {
      const m = c.get("member");
      const { id } = c.req.valid("param");
      const found = await vault().find(m.workspaceId, id);
      if (!found) return c.json({ error: "missing" }, 404);
      const refused = mayTouch(m, found, false);
      if (refused) return c.json({ error: refused }, STATUS[refused]);
      const r = await vault().rotate({ ...c.req.valid("json"), workspaceId: m.workspaceId, id, actorUserId: m.userId });
      return r.ok ? c.json({ credential: toJson(r.credential) }, 200) : c.json({ error: r.reason }, STATUS[r.reason]);
    })
    .openapi(deleteRoute, async (c) => {
      const m = c.get("member");
      const { id } = c.req.valid("param");
      const found = await vault().find(m.workspaceId, id);
      if (!found) return c.json({ error: "missing" }, 404);
      const refused = mayTouch(m, found, true);
      if (refused) return c.json({ error: refused }, STATUS[refused]);
      const r = await vault().remove({ workspaceId: m.workspaceId, id, actorUserId: m.userId, stepUp: steppedUp(m) });
      return r.ok ? c.json({ ok: true as const }, 200) : c.json({ error: r.reason }, STATUS[r.reason]);
    })
    .openapi(eventsRoute, async (c) => {
      const m = c.get("member");
      const { id } = c.req.valid("param");
      const found = await vault().find(m.workspaceId, id);
      if (!found) return c.json({ error: "missing" }, 404);
      // History is its owner's, or a manager's; a workspace secret's needs no step-up to read.
      const mine = found.scope === "user" && found.ownerUserId === m.userId;
      if (!mine && !can(m.role, "credential.manage")) return c.json({ error: "forbidden" }, 403);
      const rows = await vault().events(m.workspaceId, id);
      return c.json({ events: rows.map((e) => ({ ...e, at: e.at.toISOString() })) }, 200);
    });
}
