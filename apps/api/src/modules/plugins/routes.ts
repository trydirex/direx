// SPDX-License-Identifier: AGPL-3.0-only
// Third-party plugins over HTTP (ADR 0026). A Server admin reviews an uploaded bundle, then confirms
// it, upgrades or removes it, each after a recent sign-in (rule 001). A Workspace owner turns an
// installed plugin on or off in their Workspace (rule 002). Everyone in a Workspace sees what each
// installed plugin can do and reach.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { parseManifest, type Manifest } from "@direx/plugin-sdk";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bodyLimit } from "hono/body-limit";
import { adminSteppedUp, requirePermission, requireServerAdmin, requireStepUp, type Auth, type MemberEnv, type ServerAdminEnv } from "../identity/index";
import { installAsAdmin, listInstalled, removeAsAdmin, setTurnedOn, workspacePlugins } from "./adapters/installs";
import { isPublicSuffix } from "./adapters/public-suffix";
import { MAX_BUNDLE_BYTES, prepareInstall, storeBundle, storedBundle, upgradeDiff, type InstallPlan } from "./application/installer";
import type { ProbeResult } from "./application/probe";
import { WEBHOOK_MAX_BYTES, type PluginWebhooks } from "./application/webhooks";

const STAGE_TTL_MS = 60 * 60_000;
const PLUGIN_ID = z.string().regex(/^[a-z0-9]+(\.[a-z0-9-]+)+$/);

const ErrorBody = z.object({ error: z.string() }).openapi("Error");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const errors = {
  400: json(ErrorBody, "Invalid request"),
  401: json(ErrorBody, "Not signed in"),
  403: json(ErrorBody, "Not allowed, or step-up required"),
  404: json(ErrorBody, "Not installed, or the reviewed upload is gone"),
  409: json(ErrorBody, "Refused: already_installed, changed"),
};
const Ok = z.object({ ok: z.literal(true) }).openapi("Ok");

/** What a plugin asks for, as a person reads it before saying yes. */
const PluginSummary = z
  .object({
    pluginId: z.string(),
    name: z.string(),
    version: z.string(),
    capabilities: z.array(z.object({ kind: z.enum(["effect", "query", "trigger"]), name: z.string(), reachesPerson: z.boolean() })),
    connections: z.array(z.object({ key: z.string(), auth: z.string() })),
    egress: z.array(z.string()),
  })
  .openapi("PluginSummary");
type PluginSummary = z.infer<typeof PluginSummary>;

function summary(m: Manifest): PluginSummary {
  return {
    pluginId: m.id,
    name: m.name ?? m.id,
    version: m.version,
    // Core decides: a third-party effect always counts as reaching a Person.
    capabilities: m.capabilities.map((c) => ({ kind: c.kind, name: c.name, reachesPerson: c.kind === "effect" })),
    connections: m.connections.map((c) => ({ key: c.key, auth: c.auth })),
    egress: [...m.egress.hosts],
  };
}

const Review = z
  .object({
    stageId: z.uuid(),
    entrySha256: z.string(),
    mode: z.enum(["install", "upgrade"]),
    plugin: PluginSummary,
    added: z.array(z.string()),
    removed: z.array(z.string()),
    permissionsChanged: z.boolean(),
  })
  .openapi("PluginReview");

const listRoute = createRoute({
  method: "get",
  path: "/api/server/plugins",
  responses: { 200: json(z.object({ plugins: z.array(PluginSummary.extend({ entrySha256: z.string() })) }), "The third-party plugins installed on this server"), ...errors },
});
const reviewRoute = createRoute({
  method: "post",
  path: "/api/server/plugins/review",
  request: { body: { content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } }, required: true } },
  responses: {
    200: json(Review, "The bundle, read in the sandbox with no network: what it asks for, and what changes if it is an upgrade. Nothing is installed yet"),
    413: json(ErrorBody, "The bundle is over 10 MB"),
    422: json(z.object({ error: z.literal("refused"), reasons: z.array(z.string()) }), "Why this bundle can't be installed"),
    ...errors,
  },
});
const confirmRoute = createRoute({
  method: "post",
  path: "/api/server/plugins/confirm",
  request: { body: { content: { "application/json": { schema: z.object({ stageId: z.uuid(), entrySha256: z.string() }) } } } },
  responses: { 200: json(z.object({ plugin: PluginSummary }), "Installed or upgraded"), ...errors },
});
const removeRoute = createRoute({
  method: "delete",
  path: "/api/server/plugins/{pluginId}",
  request: { params: z.object({ pluginId: PLUGIN_ID }) },
  responses: { 200: json(Ok, "Removed; it stops in every Workspace"), ...errors },
});
const ws = z.object({ workspaceId: z.uuid() });
const workspaceListRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/plugins",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: { 200: json(z.object({ plugins: z.array(PluginSummary.extend({ on: z.boolean() })) }), "Installed third-party plugins, and whether this Workspace has each on"), ...errors },
});
const turnRoute = (method: "put" | "delete", description: string) =>
  createRoute({
    method,
    path: "/api/w/{workspaceId}/plugins/{pluginId}",
    middleware: [requirePermission("plugin.turn_on")],
    request: { params: ws.extend({ pluginId: PLUGIN_ID }) },
    responses: { 200: json(Ok, description), ...errors },
  });
const turnOnRoute = turnRoute("put", "On in this Workspace, for what the plugin may do and reach now");
const turnOffRoute = turnRoute("delete", "Off in this Workspace");

// Webhook addresses for plugin triggers (ADR 0031 rule 007).
const WebhookMade = z.object({ id: z.uuid(), path: z.string(), secret: z.string() }).openapi("PluginWebhookSecret");
const webhookListRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/plugin-webhooks",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: {
    200: json(z.object({ webhooks: z.array(z.object({ id: z.uuid(), pluginId: z.string(), trigger: z.string(), path: z.string(), createdAt: z.iso.datetime() })) }).openapi("PluginWebhooks"), "This Workspace's webhook addresses, without their secrets"),
    ...errors,
  },
});
const webhookCreateRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/plugin-webhooks",
  middleware: [requirePermission("workspace.settings"), requireStepUp("short")],
  request: { params: ws, body: { content: { "application/json": { schema: z.object({ pluginId: PLUGIN_ID, trigger: z.string().min(1).max(200) }) } } } },
  responses: { 200: json(WebhookMade, "Made; the secret is shown this once"), ...errors },
});
const webhookRotateRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/plugin-webhooks/{hookId}/rotate",
  middleware: [requirePermission("workspace.settings"), requireStepUp("short")],
  request: { params: ws.extend({ hookId: z.uuid() }) },
  responses: { 200: json(WebhookMade, "A new secret, shown this once; the old one stops working"), ...errors },
});
const webhookPath = (workspaceId: string, id: string) => `/api/hooks/plugins/${workspaceId}/${id}`;
const validWebhook = z.object({ workspaceId: z.uuid(), hookId: z.uuid() });

export type PluginRouteDeps = {
  auth: () => Auth;
  /** Where bundles are stored; undefined without a data directory, which refuses uploads. */
  storeDir: () => string | undefined;
  firstPartyIds: () => ReadonlySet<string>;
  hostVersion: string;
  /** Replaced in tests that have no sandbox. */
  probe?: (file: string, opts: { hostVersion: string }) => Promise<ProbeResult>;
  webhooks?: () => PluginWebhooks;
};

const STATUS = { forbidden: 403, step_up_required: 403, not_installed: 404, stage_gone: 404, already_installed: 409, changed: 409, no_store: 409 } as const;

export function pluginRoutes(deps: PluginRouteDeps) {
  const app = new OpenAPIHono<ServerAdminEnv & MemberEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    },
  });
  const admin = requireServerAdmin(deps.auth);
  app.use("/api/server/plugins", admin);
  app.use("/api/server/plugins/*", admin);

  const stagingDir = () => {
    const store = deps.storeDir();
    return store && join(store, "..", "plugin-staging");
  };
  const prepare = (file: string) =>
    prepareInstall(file, { hostVersion: deps.hostVersion, firstPartyIds: deps.firstPartyIds(), isPublicSuffix, ...(deps.probe && { probe: deps.probe }) });
  /** Uploads not confirmed within the hour are thrown away. */
  async function sweepStaging(dir: string) {
    for (const f of await readdir(dir).catch(() => [])) {
      const path = join(dir, f);
      const s = await stat(path).catch(() => null);
      if (s && Date.now() - s.mtimeMs > STAGE_TTL_MS) await rm(path, { force: true });
    }
  }
  async function current(pluginId: string) {
    return (await listInstalled()).find((r) => r.pluginId === pluginId);
  }
  const refuse = (reason: keyof typeof STATUS) => ({ body: { error: reason }, status: STATUS[reason] });

  const hooks = deps.webhooks;
  if (hooks) {
    app.openapi(webhookListRoute, async (c) => {
      const { workspaceId } = c.req.valid("param");
      const webhooks = (await hooks().list(workspaceId)).map((w) => ({ ...w, path: webhookPath(workspaceId, w.id) }));
      return c.json({ webhooks }, 200);
    });
    app.openapi(webhookCreateRoute, async (c) => {
      const { workspaceId } = c.req.valid("param");
      const { pluginId, trigger } = c.req.valid("json");
      const r = await hooks().create(workspaceId, pluginId, trigger, c.get("member").userId);
      if (r.ok) return c.json({ id: r.id, path: webhookPath(workspaceId, r.id), secret: r.secret }, 200);
      return c.json({ error: r.reason }, r.reason === "exists" ? 409 : 404);
    });
    app.openapi(webhookRotateRoute, async (c) => {
      const { workspaceId, hookId } = c.req.valid("param");
      const r = await hooks().rotate(workspaceId, hookId, c.get("member").userId);
      if (r.ok) return c.json({ id: r.id, path: webhookPath(workspaceId, r.id), secret: r.secret }, 200);
      return c.json({ error: r.reason }, r.reason === "stale_version" ? 409 : 404);
    });
    // No sign-in: the signature over the raw body is the only proof, and the stored webhook the URL
    // names, not the caller, says which Workspace, plugin and trigger it is for.
    app.post("/api/hooks/plugins/:workspaceId/:hookId", bodyLimit({ maxSize: WEBHOOK_MAX_BYTES, onError: (c) => c.json({ error: "too_large" }, 413) }), async (c) => {
      const p = validWebhook.safeParse(c.req.param());
      if (!p.success) return c.json({ error: "bad_signature" }, 401);
      const r = await hooks().receive(p.data.workspaceId, p.data.hookId, new Uint8Array(await c.req.arrayBuffer()), c.req.header());
      if (r.ok) return c.json({ ok: true, accepted: r.accepted }, 200);
      const status = r.reason === "bad_signature" || r.reason === "no_secret" ? 401 : r.reason === "too_large" ? 413 : r.reason === "unknown_trigger" ? 404 : 400;
      return c.json({ error: r.reason === "no_secret" ? "bad_signature" : r.reason }, status);
    });
  }

  return app
    .openapi(listRoute, async (c) => {
      const plugins = (await listInstalled()).flatMap((r) => {
        const m = parseManifest(r.manifest);
        return m.ok ? [{ ...summary(m.manifest), entrySha256: r.entrySha256 }] : [];
      });
      return c.json({ plugins }, 200);
    })
    .openapi(reviewRoute, async (c) => {
      if (!adminSteppedUp(c.get("admin"))) return c.json(refuse("step_up_required").body, 403);
      const dir = stagingDir();
      if (!dir) return c.json(refuse("no_store").body, 409);
      const declared = Number(c.req.header("content-length") ?? "0");
      if (declared > MAX_BUNDLE_BYTES) return c.json({ error: "too_large" }, 413);
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength > MAX_BUNDLE_BYTES) return c.json({ error: "too_large" }, 413);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await sweepStaging(dir);
      const stageId = crypto.randomUUID();
      const file = join(dir, `${stageId}.js`);
      await writeFile(file, bytes, { mode: 0o400 });
      const r = await prepare(file);
      if (!r.ok) {
        await rm(file, { force: true });
        return c.json({ error: "refused" as const, reasons: r.reasons }, 422);
      }
      const m = r.plan.manifest;
      const now = await current(m.id);
      const before = now && parseManifest(now.manifest);
      const diff = before?.ok ? upgradeDiff(before.manifest, m) : { added: [], removed: [] };
      return c.json(
        {
          stageId,
          entrySha256: r.plan.entrySha256,
          mode: now ? ("upgrade" as const) : ("install" as const),
          plugin: summary(m),
          ...diff,
          permissionsChanged: before?.ok ? diff.added.length + diff.removed.length > 0 : false,
        },
        200,
      );
    })
    .openapi(confirmRoute, async (c) => {
      const a = c.get("admin");
      if (!adminSteppedUp(a)) return c.json(refuse("step_up_required").body, 403);
      const dir = stagingDir();
      const store = deps.storeDir();
      if (!dir || !store) return c.json(refuse("no_store").body, 409);
      const { stageId, entrySha256 } = c.req.valid("json");
      const file = join(dir, `${stageId}.js`);
      if (!(await stat(file).catch(() => null))) return c.json(refuse("stage_gone").body, 404);
      // Read and checked again: what is installed is exactly what the person reviewed.
      const r = await prepare(file);
      if (!r.ok || r.plan.entrySha256 !== entrySha256) return c.json(refuse("changed").body, 409);
      const plan: InstallPlan = r.plan;
      const mode = (await current(plan.manifest.id)) ? "upgrade" : "install";
      await storeBundle(plan, store);
      const refused = await installAsAdmin(a.userId, mode, { pluginId: plan.manifest.id, version: plan.manifest.version, manifest: plan.manifest, permissionHash: plan.permissionHash, entrySha256 });
      if (refused) return c.json(refuse(refused).body, STATUS[refused]);
      await rm(file, { force: true });
      return c.json({ plugin: summary(plan.manifest) }, 200);
    })
    .openapi(removeRoute, async (c) => {
      const a = c.get("admin");
      if (!adminSteppedUp(a)) return c.json(refuse("step_up_required").body, 403);
      const { pluginId } = c.req.valid("param");
      const was = await current(pluginId);
      const refused = await removeAsAdmin(a.userId, pluginId);
      if (refused) return c.json(refuse(refused).body, STATUS[refused]);
      const store = deps.storeDir();
      if (store && was && !(await listInstalled()).some((r) => r.entrySha256 === was.entrySha256)) await rm(storedBundle(store, was.entrySha256), { force: true });
      return c.json({ ok: true as const }, 200);
    })
    .openapi(workspaceListRoute, async (c) => {
      const rows = await workspacePlugins(c.req.valid("param").workspaceId);
      const plugins = rows.flatMap((r) => {
        const m = parseManifest(r.manifest);
        return m.ok ? [{ ...summary(m.manifest), on: r.on }] : [];
      });
      return c.json({ plugins }, 200);
    })
    .openapi(turnOnRoute, async (c) => {
      const { workspaceId, pluginId } = c.req.valid("param");
      const refused = await setTurnedOn(workspaceId, pluginId, c.get("member").userId, true);
      return refused ? c.json(refuse(refused).body, 404) : c.json({ ok: true as const }, 200);
    })
    .openapi(turnOffRoute, async (c) => {
      const { workspaceId, pluginId } = c.req.valid("param");
      await setTurnedOn(workspaceId, pluginId, c.get("member").userId, false);
      return c.json({ ok: true as const }, 200);
    });
}
