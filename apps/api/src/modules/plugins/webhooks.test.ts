// SPDX-License-Identifier: AGPL-3.0-only
// Webhook triggers over HTTP, through the real identity routes, vault and database (ADR 0031 rule
// 007): the stored webhook the URL names says which Workspace, plugin and trigger a delivery is for,
// the signature over the raw body is checked in the vault, bodies over the limit are refused, and a
// repeated delivery hands nothing off twice.
import { definePlugin } from "@direx/plugin-sdk";
import { createHmac } from "node:crypto";
import { expect, test } from "vitest";
import { createVault, rootKeyFromEnv } from "../credentials/index";
import { TEST_SECRET, testIdentity } from "../identity/test-auth";
import { behavePlugin } from "./fixtures/behave-plugin";
import { createPluginWebhooks, loadPlugins, pluginRoutes, webhookVerifier, HOST_VERSION, WEBHOOK_MAX_BYTES, type TriggerEvent } from "./index";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;
const PLUGIN = "com.example.behave";
const handed: TriggerEvent[] = [];

const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "22".repeat(32) })!, now: () => new Date() });
const plugin = definePlugin({
  ...behavePlugin,
  triggers: { ...behavePlugin.triggers, "behave.hook": { normalize: async (payload) => (payload as { events: { eventId: string; data: unknown }[] }).events } },
});
const plugins = loadPlugins({
  sources: [{ mode: "in_process", plugin }],
  credentials: async () => null,
  confinement: "none",
  log: () => {},
  verifyWebhook: webhookVerifier(() => vault),
  onEvent: async (_tx, e) => void handed.push(e),
});
const webhooks = createPluginWebhooks({ vault: () => vault, plugins: () => plugins });

const identity = testIdentity();
identity.routes.route("/", pluginRoutes({ auth: identity.auth, storeDir: () => undefined, firstPartyIds: () => new Set(), hostVersion: HOST_VERSION, webhooks: () => webhooks }));
const cookie = await identity.signIn();
const W = (await identity.createOrg(cookie, "Acme")).workspace.id;
const base = `/api/w/${W}/plugin-webhooks`;

const body = (ids: string[]) => JSON.stringify({ events: ids.map((eventId) => ({ eventId, data: { id: eventId } })) });
const send = (path: string, raw: string, secret: string) =>
  identity.routes.request(path, { method: "POST", headers: { "content-type": "application/json", "x-signature": createHmac("sha256", secret).update(raw).digest("hex") }, body: raw });

test("an Admin makes one webhook per declared trigger, and its secret is shown once", async () => {
  expect((await identity.call(base, cookie, { method: "POST", body: { pluginId: PLUGIN, trigger: "behave.feed" } })).status).toBe(404);
  expect((await identity.call(base, cookie, { method: "POST", body: { pluginId: "com.example.nope", trigger: "behave.hook" } })).status).toBe(404);
  const res = await identity.call(base, cookie, { method: "POST", body: { pluginId: PLUGIN, trigger: "behave.hook" } });
  expect(res.status).toBe(200);
  const made = (await res.json()) as { id: string; path: string; secret: string };
  expect(made.path).toBe(`/api/hooks/plugins/${W}/${made.id}`);
  expect(made.secret).toMatch(/^[0-9a-f]{64}$/);
  expect((await identity.call(base, cookie, { method: "POST", body: { pluginId: PLUGIN, trigger: "behave.hook" } })).status).toBe(409);
  const listed = (await (await identity.call(base, cookie)).json()) as { webhooks: unknown[] };
  expect(listed).toEqual({ webhooks: [{ id: made.id, pluginId: PLUGIN, trigger: "behave.hook", path: made.path, createdAt: expect.any(String) }] });
  expect(JSON.stringify(listed)).not.toContain(made.secret);

  // A signed delivery reaches the stored trigger in this Workspace; sending it again hands nothing off.
  const raw = body(["e1", "e2"]);
  const first = await send(made.path, raw, made.secret);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ ok: true, accepted: 2 });
  expect(handed.filter((e) => e.workspaceId === W).map((e) => [e.pluginId, e.trigger, e.eventId])).toEqual([
    [PLUGIN, "behave.hook", "e1"],
    [PLUGIN, "behave.hook", "e2"],
  ]);
  expect(await (await send(made.path, raw, made.secret)).json()).toEqual({ ok: true, accepted: 0 });

  // Wrong secret, no signature, an unknown address and another Workspace's path all read the same.
  expect((await send(made.path, raw, "wrong")).status).toBe(401);
  expect((await identity.routes.request(made.path, { method: "POST", body: raw })).status).toBe(401);
  expect((await send(`/api/hooks/plugins/${W}/${crypto.randomUUID()}`, raw, made.secret)).status).toBe(401);
  const other = await identity.signIn();
  const W2 = (await identity.createOrg(other, "Delta")).workspace.id;
  expect((await send(`/api/hooks/plugins/${W2}/${made.id}`, raw, made.secret)).status).toBe(401);
  expect((await send(`/api/hooks/plugins/not-a-uuid/${made.id}`, raw, made.secret)).status).toBe(401);
  expect((await identity.call(`/api/w/${W2}/plugin-webhooks/${made.id}/rotate`, other, { method: "POST" })).status).toBe(404);

  // A body over the limit is refused before it is read; one that isn't JSON is refused after the check.
  const big = "x".repeat(WEBHOOK_MAX_BYTES + 1);
  expect((await send(made.path, big, made.secret)).status).toBe(413);
  expect((await send(made.path, "not json", made.secret)).status).toBe(400);

  // Rotating stops the old secret at once.
  const turned = (await (await identity.call(`${base}/${made.id}/rotate`, cookie, { method: "POST" })).json()) as { secret: string };
  expect((await send(made.path, body(["e3"]), made.secret)).status).toBe(401);
  expect(await (await send(made.path, body(["e3"]), turned.secret)).json()).toEqual({ ok: true, accepted: 1 });
  expect(handed.filter((e) => e.workspaceId === W2)).toEqual([]);
});

test("receive refuses an oversized body even without the route's limit", async () => {
  expect(await webhooks.receive(W, crypto.randomUUID(), new Uint8Array(WEBHOOK_MAX_BYTES + 1), {})).toEqual({ ok: false, reason: "too_large" });
});
