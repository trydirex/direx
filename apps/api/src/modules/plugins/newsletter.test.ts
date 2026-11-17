// SPDX-License-Identifier: AGPL-3.0-only
// Core finds a newsletter provider from its manifest, whichever plugin it is.
import { createBeehiivPlugin, createFakeBeehiiv, firstPartyPlugins, NEEDS_PRO } from "@direx/extensions";
import { parseManifest } from "@direx/plugin-sdk";
import { expect, test } from "vitest";
import { newsletterShapes } from "./application/newsletter";
import { inProcessCall } from "./application/in-process";
import { behaveManifest } from "./fixtures/manifest";
import { keyConnections, newsletterLists } from "./index";

const manifest = {
  id: "com.example.letter",
  name: "Letter",
  apiVersion: 1,
  version: "0.1.0",
  minHostVersion: "0.1.0",
  trust: "first_party",
  connections: [{ key: "letter", auth: "api_key" }],
  egress: { hosts: ["api.example.com"] },
  capabilities: [
    { kind: "effect", name: "newsletter.draft", connection: "letter", dedupe: "queryable", risk: "low", reachesPerson: false },
    { kind: "effect", name: "newsletter.send", connection: "letter", dedupe: "queryable", risk: "high", reachesPerson: true },
    { kind: "effect", name: "newsletter.cancel", connection: "letter", dedupe: "queryable", risk: "low", reachesPerson: false },
    { kind: "effect", name: "newsletter.publish", connection: "letter", dedupe: "queryable", risk: "high", reachesPerson: true },
    { kind: "query", name: "newsletter.subscribers", connection: "letter" },
    { kind: "query", name: "newsletter.profile", connection: "letter" },
    { kind: "query", name: "newsletter.stats", connection: "letter" },
  ],
};

const parsed = (m: unknown) => {
  const r = parseManifest(m);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.manifest;
};
const without = (name: string) => parsed({ ...manifest, capabilities: manifest.capabilities.filter((c) => c.name !== name) });

test("a plugin with all five capabilities on a connection is a newsletter provider", () => {
  expect(newsletterShapes(parsed(manifest))).toEqual({ shapes: [{ connection: "letter", sendDedupe: "queryable", publishDedupe: "queryable", publishLeadMs: 0, hasStats: true, hasLists: false }], incomplete: [] });
});

test("stats are optional", () => {
  expect(newsletterShapes(without("newsletter.stats"))).toEqual({ shapes: [{ connection: "letter", sendDedupe: "queryable", publishDedupe: "queryable", publishLeadMs: 0, hasStats: false, hasLists: false }], incomplete: [] });
});

test("a tool whose account holds several lists says so with a lists query", () => {
  const withLists = parsed({ ...manifest, capabilities: [...manifest.capabilities, { kind: "query", name: "newsletter.lists", connection: "letter" }] });
  expect(newsletterShapes(withLists).shapes[0]).toMatchObject({ connection: "letter", hasLists: true });
});

test.each(["newsletter.draft", "newsletter.send", "newsletter.cancel", "newsletter.publish", "newsletter.subscribers", "newsletter.profile"])("a plugin lacking %s is not a newsletter provider, and says so", (name) => {
  expect(newsletterShapes(without(name))).toEqual({ shapes: [], incomplete: [{ connection: "letter", missing: [name] }] });
});

test("Kit and beehiiv are newsletter providers, and take a pasted key", () => {
  const plugins = firstPartyPlugins().filter((p) => ["com.trydirex.kit", "com.trydirex.beehiiv"].includes(p.manifest.id));
  expect(plugins.map((p) => newsletterShapes(p.manifest))).toEqual([
    { shapes: [{ connection: "kit", sendDedupe: "queryable", publishDedupe: "queryable", publishLeadMs: 300_000, hasStats: true, hasLists: false }], incomplete: [] },
    { shapes: [{ connection: "beehiiv", sendDedupe: "blind", publishDedupe: "blind", publishLeadMs: 0, hasStats: true, hasLists: false }], incomplete: [] },
  ]);
  expect(keyConnections(plugins.map((p) => p.manifest))).toEqual([
    { connection: "kit", name: "Kit", balance: null, profile: "com.trydirex.kit/newsletter.profile" },
    { connection: "beehiiv", name: "beehiiv", balance: null, profile: "com.trydirex.beehiiv/newsletter.profile" },
  ]);
});

test("the newsletter lists are Kit and beehiiv, each with its subscribers query", () => {
  expect(newsletterLists(firstPartyPlugins().map((p) => p.manifest))).toEqual([
    { connection: "kit", name: "Kit", subscribers: "com.trydirex.kit/newsletter.subscribers", profile: "com.trydirex.kit/newsletter.profile", stats: "com.trydirex.kit/newsletter.stats", lists: null, publish: "com.trydirex.kit/newsletter.publish", publishDedupe: "queryable", publishLeadMs: 300_000 },
    { connection: "beehiiv", name: "beehiiv", subscribers: "com.trydirex.beehiiv/newsletter.subscribers", profile: "com.trydirex.beehiiv/newsletter.profile", stats: "com.trydirex.beehiiv/newsletter.stats", lists: null, publish: "com.trydirex.beehiiv/newsletter.publish", publishDedupe: "blind", publishLeadMs: 0 },
  ]);
});

test("a plugin with no newsletter capabilities is left alone", () => {
  expect(newsletterShapes(parsed(behaveManifest))).toEqual({ shapes: [], incomplete: [] });
});

test("beehiiv's refusal on its plan reaches the host with the plan as a field, and its detail is only words", async () => {
  const bh = createFakeBeehiiv({ sendApi: false });
  const call = inProcessCall(createBeehiivPlugin({ fetch: bh.fetch }), () => {});
  const { spec } = (await call("w1", "prepare", { capability: "newsletter.draft", input: { title: "Week 12", html: "<p>Hi</p>" } })) as { spec: unknown };
  const r = await call("w1", "execute", { capability: "newsletter.draft", spec, idempotencyKey: "a1", credential: { key: bh.key } });
  expect(r).toMatchObject({ kind: "refused", retryable: false, plan: "Pro" });
  expect((r as { detail: string }).detail).toBe(NEEDS_PRO);
  expect(Object.keys(r as object)).toContain("plan");
});
