// SPDX-License-Identifier: AGPL-3.0-only
// The TikTok plugin against a local server. Responses are written from TikTok's docs and get
// replaced with real ones when a real account connects.
import { invoke } from "../../test-wire";
import { afterAll, beforeEach, expect, test } from "vitest";
import { fakeTikTok, tiktokError } from "./fake-tiktok";
import { createTikTokPlugin } from "./plugin";
import { TIKTOK_PROVIDER } from "./provider";

const fake = fakeTikTok();
afterAll(() => fake.stop());
const logged: string[] = [];
beforeEach(() => {
  fake.calls.length = 0;
  logged.length = 0;
});
const p = createTikTokPlugin({ baseUrl: fake.url, timeoutMs: 1000 });
const credential = { accessToken: "act-secret", expiresAt: "2030-01-01T00:00:00.000Z" };
const ask = async (capability: string) => ((await invoke(p, "query", { capability, input: null, credential }, { workspaceId: "w", log: (m) => logged.push(m) })) as { output: unknown }).output;

test("a login is its account: the open id and display name, from one call", async () => {
  expect(await ask("social.identity")).toEqual({ accountId: "723f24d7-e717-40f8-a2b6-cb8464cd23b4", accountLabel: "Acme", accountType: "creator" });
  expect(fake.calls).toEqual([{ path: "/v2/user/info/?fields=open_id,display_name", auth: "Bearer act-secret" }]);
});

test("an answer with no open id fails the connect", async () => {
  fake.answer(() => Response.json({ data: { user: {} }, error: { code: "ok" } }));
  await expect(ask("social.identity")).rejects.toThrow("TikTok did not say which account this is");
});

test("health: a 401 needs a reconnect, rate limits and outages don't", async () => {
  for (const [answer, reason] of [[() => tiktokError(401, "access_token_invalid"), "auth"], [() => tiktokError(429, "rate_limit_exceeded"), "other"], [() => new Response(null, { status: 500 }), "other"]] as const) {
    fake.answer(answer);
    expect(await ask("social.health")).toEqual({ ok: false, reason });
  }
});

test("no token in any error or logged line", async () => {
  fake.answer(() => new Response("act-secret", { status: 500 }));
  await expect(ask("social.identity")).rejects.not.toThrow(/act-secret/);
  await ask("social.health");
  expect(logged.join("\n")).not.toContain("act-secret");
});

test("it holds only the two queries and reaches only TikTok's API host", () => {
  expect(p.manifest.capabilities.map((c) => [c.kind, c.name])).toEqual([["query", "social.identity"], ["query", "social.health"]]);
  expect(p.manifest.egress.hosts).toEqual(["open.tiktokapis.com"]);
});

test("the provider names the client a key, sends the pair on revoke, and joins scopes with commas", () => {
  expect([TIKTOK_PROVIDER.clientIdParam, TIKTOK_PROVIDER.revokeClient, TIKTOK_PROVIDER.pkce, TIKTOK_PROVIDER.scopeSeparator]).toEqual(["client_key", true, false, ","]);
});
