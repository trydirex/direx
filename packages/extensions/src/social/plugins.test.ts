// SPDX-License-Identifier: AGPL-3.0-only
// X, Bluesky, Facebook, Instagram and Threads against a local server. Responses are written from each
// platform's docs and get replaced with real ones when a real account connects.
import { type Plugin } from "@direx/plugin-sdk";
import { invoke } from "../test-wire";
import { afterAll, beforeEach, expect, test } from "vitest";
import { firstPartyPlugins, socialNetworks, socialProviders } from "../index";
import { createBlueskyPlugin } from "./bluesky/plugin";
import { createFacebookPlugin } from "./facebook/plugin";
import { createInstagramPlugin } from "./instagram/plugin";
import { createThreadsPlugin } from "./threads/plugin";
import { socialManifest } from "./http";
import { createXPlugin } from "./x/plugin";

const seen: { path: string; body: string }[] = [];
let answer: (path: string) => Response;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    seen.push({ path: u.pathname + u.search, body: await req.text() });
    return answer(u.pathname);
  },
});
afterAll(() => server.stop(true));
beforeEach(() => {
  seen.length = 0;
});
const o = { baseUrl: `http://localhost:${server.port}`, timeoutMs: 1000 };
const token = { accessToken: "tok", expiresAt: "2030-01-01T00:00:00.000Z" };
const ask = async (p: Plugin, capability: string, credential: unknown = token) => ((await invoke(p, "query", { capability, input: null, credential }, { workspaceId: "w", log: () => undefined })) as { output: unknown }).output;
const identity = (p: Plugin, c?: unknown) => ask(p, "social.identity", c);
const health = (p: Plugin, c?: unknown) => ask(p, "social.health", c);

test("X: identity from users/me; 401 asks for a reconnect, 403 and 429 don't", async () => {
  const p = createXPlugin(o);
  answer = () => Response.json({ data: { id: "1", username: "ana", name: "Ana" } });
  expect(await identity(p)).toEqual({ accountId: "1", accountLabel: "@ana", accountType: "user" });
  expect(seen[0]!.path).toBe("/2/users/me");
  for (const [status, reason] of [[401, "auth"], [403, "other"], [429, "other"]] as const) {
    answer = () => new Response(null, { status });
    expect(await health(p)).toEqual({ ok: false, reason });
  }
});

const pass = (password: string) => ({ username: "ana.bsky.social", password });
test("Bluesky: signs in with an app password and takes its id from the session", async () => {
  const p = createBlueskyPlugin(o);
  answer = () => Response.json({ did: "did:plc:1", handle: "ana.bsky.social", accessJwt: "a", refreshJwt: "r" });
  expect(await identity(p, pass("abcd-efgh-ijkl-mnop"))).toEqual({ accountId: "did:plc:1", accountLabel: "@ana.bsky.social", accountType: "user" });
  expect(seen[0]!.path).toBe("/xrpc/com.atproto.server.createSession");
  expect(JSON.parse(seen[0]!.body)).toEqual({ identifier: "ana.bsky.social", password: "abcd-efgh-ijkl-mnop" });
  expect(JSON.stringify(await identity(p, pass("abcd-efgh-ijkl-mnop")))).not.toContain("accessJwt");
});

test("Bluesky: a pasted space and a handle's @ don't stop a sign-in", async () => {
  const p = createBlueskyPlugin(o);
  await identity(p, { username: " @ana.bsky.social ", password: " abcd-efgh-ijkl-mnop\n" });
  expect(JSON.parse(seen.at(-1)!.body)).toEqual({ identifier: "ana.bsky.social", password: "abcd-efgh-ijkl-mnop" });
});

test("Bluesky: a main password is refused before any call, and a wrong one fails", async () => {
  const p = createBlueskyPlugin(o);
  await expect(identity(p, pass("my main password"))).rejects.toThrow(/app password/);
  expect(seen).toHaveLength(0);
  answer = () => Response.json({ error: "AuthenticationRequired" }, { status: 401 });
  await expect(identity(p, pass("abcd-efgh-ijkl-mnop"))).rejects.toThrow("Bluesky didn't accept that handle and app password. Check both and try again.");
  expect(await health(p, pass("abcd-efgh-ijkl-mnop"))).toEqual({ ok: false, reason: "auth" });
  answer = () => new Response(null, { status: 429 });
  expect(await health(p, pass("abcd-efgh-ijkl-mnop"))).toEqual({ ok: false, reason: "other" });
});

const facebook = (path: string) => {
  if (path === "/me/permissions") return Response.json({ data: [{ permission: "pages_show_list", status: "granted" }, { permission: "pages_manage_posts", status: "declined" }] });
  if (path === "/me/accounts") return Response.json({ data: [{ id: "10", name: "Acme", category: "Shop", access_token: "PAGE-TOKEN" }, { id: "11", name: "Beta", access_token: "PAGE-TOKEN" }] });
  return Response.json({ id: "7", name: "Ana" });
};
test("Facebook: only granted scopes count, Pages are the targets, and Page tokens go no further", async () => {
  answer = facebook;
  const r = await identity(createFacebookPlugin(o));
  expect(r).toEqual({ accountId: "7", accountLabel: "Ana", scopes: ["pages_show_list"], targets: [{ id: "10", name: "Acme", type: "page" }, { id: "11", name: "Beta", type: "page" }] });
  expect(JSON.stringify(r)).not.toContain("PAGE-TOKEN");
});

test("Meta's error codes: 190 and 102 are dead tokens at any status, throttling isn't", async () => {
  const p = createFacebookPlugin(o);
  answer = () => Response.json({ error: { code: 190 } }, { status: 400 });
  expect(await health(p)).toEqual({ ok: false, reason: "auth" });
  answer = () => Response.json({ error: { code: 102 } }, { status: 200 });
  expect(await health(p)).toEqual({ ok: false, reason: "auth" });
  answer = () => Response.json({ error: { code: 4 } }, { status: 403 });
  expect(await health(p)).toEqual({ ok: false, reason: "other" });
});

test("Instagram: the account id is user_id, not id", async () => {
  answer = () => Response.json({ id: "app-scoped", user_id: "178", username: "acme", account_type: "Business" });
  expect(await identity(createInstagramPlugin(o))).toEqual({ accountId: "178", accountLabel: "@acme", accountType: "professional" });
});

test("Threads: states when its data access ends", async () => {
  answer = () => Response.json({ id: "5", username: "ana" });
  const at = Date.parse("2026-01-01T00:00:00.000Z");
  expect(await identity(createThreadsPlugin({ ...o, now: () => at }))).toEqual({ accountId: "5", accountLabel: "@ana", accountType: "profile", grantExpiresAt: "2026-04-01T00:00:00.000Z" });
});

test("every OAuth network has a plugin, a provider and a descriptor, and only the built networks can publish", () => {
  const plugins = firstPartyPlugins().filter((p) => p.manifest.capabilities.some((c) => c.name === "social.identity"));
  const connections = plugins.map((p) => p.manifest.connections[0]!.key).sort();
  expect(connections).toEqual(["bluesky", "facebook", "instagram", "linkedin", "linkedin_page", "threads", "tiktok", "x", "youtube"]);
  const reads = ["social.identity", "social.health"];
  const readers = ["bluesky", "threads"];
  for (const p of plugins) {
    const key = p.manifest.connections[0]!.key;
    expect(p.manifest.capabilities.map((c) => c.name)).toEqual(["instagram", "linkedin_page", "tiktok", "youtube"].includes(key) ? reads : [...reads, ...(readers.includes(key) ? ["social.posts"] : []), "social.publish"]);
  }
  expect(socialProviders().map((p) => p.connection).sort()).toEqual(connections.filter((c) => c !== "bluesky"));
  for (const c of connections) expect(socialNetworks().map((n) => n.connection)).toContain(c);
});

test("socialManifest declares social.posts only when asked, and is otherwise unchanged", () => {
  const m = { id: "com.example.net", connection: "net", hosts: ["api.example.com"] };
  const reads = [
    { kind: "query", name: "social.identity", connection: "net" },
    { kind: "query", name: "social.health", connection: "net" },
  ];
  const today = { id: m.id, apiVersion: 1, version: "0.1.0", minHostVersion: "0.1.0", trust: "first_party", connections: [{ key: "net", auth: "oauth2" }], egress: { hosts: m.hosts }, capabilities: reads };
  expect(socialManifest(m)).toStrictEqual(today);
  expect(socialManifest({ ...m, posts: false })).toStrictEqual(today);
  expect(socialManifest({ ...m, posts: true })).toStrictEqual({ ...today, capabilities: [...reads, { kind: "query", name: "social.posts", connection: "net" }] });
});

test("the list has 21 networks, without Skool, Reddit closed, and nothing marked available", () => {
  const networks = socialNetworks();
  expect(networks.filter((n) => !n.variantOf)).toHaveLength(21);
  expect(networks.map((n) => n.connection)).not.toContain("skool");
  expect(networks.find((n) => n.connection === "reddit")?.availability).toEqual({ cloud: "not_available", self_host: "not_available" });
  for (const n of networks) expect([n.availability.cloud, n.availability.self_host]).not.toContain("available");
  // LinkedIn Pages need a registered organisation, so they wait on LinkedIn's review like the rest.
  expect(networks.find((n) => n.connection === "linkedin_page")?.availability.cloud).toBe("awaiting_approval");
});

test("a built network says how to set it up, except Bluesky, which needs no app", () => {
  for (const n of socialNetworks()) {
    if (n.availability.self_host !== "awaiting_approval") continue;
    if (n.connect === "form") expect(n.fields?.length).toBeGreaterThan(0);
    else expect(n.wizard?.scopes.length).toBeGreaterThan(0);
  }
});
