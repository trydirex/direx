// SPDX-License-Identifier: AGPL-3.0-only
// Webhook intake: the host checks the signature before the plugin sees anything, and
// each event reaches onEvent once.
import { createHmac } from "node:crypto";
import { expect, test } from "vitest";
import { definePlugin } from "@direx/plugin-sdk";
import { behavePlugin } from "./fixtures/behave-plugin";
import { loadPlugins, type TriggerEvent, type WebhookRequest } from "./index";

const SECRET = "whsec-test-0123456789";
const normalized: unknown[] = [];
const handed: TriggerEvent[] = [];
const logs: string[] = [];
let failNext = false;

const plugin = definePlugin({
  ...behavePlugin,
  triggers: {
    ...behavePlugin.triggers,
    "behave.hook": {
      normalize: async (payload, ctx) => {
        normalized.push({ payload, ctx: { workspaceId: ctx.workspaceId } });
        return (payload as { events: { eventId: string; data: unknown }[] }).events;
      },
    },
  },
});
const plugins = loadPlugins({
  sources: [{ mode: "in_process", plugin }],
  credentials: async () => null,
  confinement: "none",
  log: (l) => logs.push(l),
  verifyWebhook: async (_w, _p, _t, rawBody, signature) => sign(rawBody) === signature,
  onEvent: async (_tx, e) => {
    if (failNext) {
      failNext = false;
      throw new Error("consumer failed");
    }
    handed.push(e);
  },
});

const body = (ids: string[], pad = "") =>
  new TextEncoder().encode(`{ "events" :${pad}${JSON.stringify(ids.map((eventId) => ({ eventId, data: { id: eventId } })))} }`);
const sign = (b: Uint8Array, secret = SECRET) => createHmac("sha256", secret).update(b).digest("hex");
const delivery = (workspaceId: string, rawBody: Uint8Array, headers: Record<string, string | undefined>): WebhookRequest => ({
  workspaceId,
  pluginId: "com.example.behave",
  trigger: "behave.hook",
  headers,
  rawBody,
});
const forWs = (ws: string) => handed.filter((e) => e.workspaceId === ws).map((e) => e.eventId);

test("a signed delivery is normalized by the plugin and each event handed off", async () => {
  const W = crypto.randomUUID();
  const b = body(["a1", "a2"], "\n   ");
  expect(await plugins.ingestWebhook(delivery(W, b, { "x-signature": sign(b) }))).toEqual({ ok: true, accepted: 2 });
  expect(handed.filter((e) => e.workspaceId === W)).toEqual([
    { workspaceId: W, pluginId: "com.example.behave", trigger: "behave.hook", credentialId: null, eventId: "a1", data: { id: "a1" }, custom: true },
    { workspaceId: W, pluginId: "com.example.behave", trigger: "behave.hook", credentialId: null, eventId: "a2", data: { id: "a2" }, custom: true },
  ]);
});

test("the header name ignores case and may carry a sha256= prefix", async () => {
  const b = body(["b1"]);
  expect(await plugins.ingestWebhook(delivery(crypto.randomUUID(), b, { "X-Signature": `sha256=${sign(b).toUpperCase()}` }))).toEqual({
    ok: true,
    accepted: 1,
  });
});

test("a missing or wrong signature is refused before the plugin is called", async () => {
  const W = crypto.randomUUID();
  const b = body(["c1"]);
  const before = normalized.length;
  for (const headers of [{}, { "x-signature": "nope" }, { "x-signature": sign(b, "other-secret") }, { "x-signature": sign(body(["c2"])) }]) {
    expect(await plugins.ingestWebhook(delivery(W, b, headers))).toEqual({ ok: false, reason: "bad_signature" });
  }
  expect(normalized.length).toBe(before);
  expect(forWs(W)).toEqual([]);
});

test("the webhook secret never reaches the plugin or a log line", async () => {
  const b = body(["d1"]);
  await plugins.ingestWebhook(delivery(crypto.randomUUID(), b, { "x-signature": sign(b) }));
  expect(JSON.stringify(normalized)).not.toContain(SECRET);
  expect(logs.join("\n")).not.toContain(SECRET);
});

test("the same event delivered twice, even at once, is handed off once; another workspace is separate", async () => {
  const W = crypto.randomUUID();
  const b = body(["e1", "e2"]);
  const req = delivery(W, b, { "x-signature": sign(b) });
  const results = await Promise.all([plugins.ingestWebhook(req), plugins.ingestWebhook(req)]);
  expect(results.map((r) => (r.ok ? r.accepted : -1)).sort()).toEqual([0, 2]);
  expect(await plugins.ingestWebhook(req)).toEqual({ ok: true, accepted: 0 });
  expect(forWs(W)).toEqual(["e1", "e2"]);
  const other = crypto.randomUUID();
  expect(await plugins.ingestWebhook(delivery(other, b, { "x-signature": sign(b) }))).toEqual({ ok: true, accepted: 2 });
});

test("a consumer that fails rolls the batch back, so the retry hands the events off once", async () => {
  const W = crypto.randomUUID();
  const b = body(["f1", "f2"]);
  const req = delivery(W, b, { "x-signature": sign(b) });
  failNext = true;
  await expect(plugins.ingestWebhook(req)).rejects.toThrow(/consumer failed/);
  expect(forWs(W)).toEqual([]);
  expect(await plugins.ingestWebhook(req)).toEqual({ ok: true, accepted: 2 });
  expect(forWs(W)).toEqual(["f1", "f2"]);
});

test("an unknown trigger, a body that is not JSON and a missing secret are refused", async () => {
  const W = crypto.randomUUID();
  const junk = new TextEncoder().encode("not json");
  expect(await plugins.ingestWebhook({ ...delivery(W, junk, { "x-signature": sign(junk) }), trigger: "behave.feed" })).toEqual({
    ok: false,
    reason: "unknown_trigger",
  });
  expect(await plugins.ingestWebhook(delivery(W, junk, { "x-signature": sign(junk) }))).toEqual({ ok: false, reason: "bad_payload" });
  const noSecret = loadPlugins({ sources: [{ mode: "in_process", plugin }], credentials: async () => null, confinement: "none", log: () => {}, verifyWebhook: async () => null, onEvent: async () => {} });
  expect(await noSecret.ingestWebhook(delivery(W, junk, { "x-signature": sign(junk) }))).toEqual({ ok: false, reason: "no_secret" });
});
