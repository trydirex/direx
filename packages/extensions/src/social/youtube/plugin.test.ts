// SPDX-License-Identifier: AGPL-3.0-only
// The YouTube plugin against a local server. Responses are written from Google's docs and get
// replaced with real ones when a real channel connects.
import { invoke } from "../../test-wire";
import { afterAll, beforeEach, expect, test } from "vitest";
import { fakeYouTube, youtubeError } from "./fake-youtube";
import { createYouTubePlugin } from "./plugin";

const fake = fakeYouTube();
afterAll(() => fake.stop());
const logged: string[] = [];
beforeEach(() => {
  fake.calls.length = 0;
  logged.length = 0;
});
const p = createYouTubePlugin({ baseUrl: fake.url, timeoutMs: 1000 });
const credential = { accessToken: "ya29-secret", expiresAt: "2030-01-01T00:00:00.000Z" };
const ask = async (capability: string) => ((await invoke(p, "query", { capability, input: null, credential }, { workspaceId: "w", log: (m) => logged.push(m) })) as { output: unknown }).output;

test("a login is its channel: the channel id and title, from one call", async () => {
  expect(await ask("social.identity")).toEqual({ accountId: "UC1", accountLabel: "Acme", accountType: "channel" });
  expect(fake.calls).toEqual([{ path: "/youtube/v3/channels?part=snippet&mine=true", auth: "Bearer ya29-secret" }]);
});

test("a Google account with no channel is refused, whichever way Google says so", async () => {
  for (const answer of [() => Response.json({ kind: "youtube#channelListResponse", pageInfo: { totalResults: 0 }, items: [] }), () => Response.json({ kind: "youtube#channelListResponse", pageInfo: { totalResults: 0 } }), () => youtubeError(401, "youtubeSignupRequired")]) {
    fake.answer(answer);
    await expect(ask("social.identity")).rejects.toThrow("This Google account has no YouTube channel");
  }
});

test("any other refusal fails the connect without saying there is no channel", async () => {
  fake.answer(() => youtubeError(401, "authError"));
  await expect(ask("social.identity")).rejects.not.toThrow(/no YouTube channel/);
});

test("health: a 401 needs a reconnect, quota and outages don't", async () => {
  for (const [answer, reason] of [[() => youtubeError(401, "authError"), "auth"], [() => youtubeError(401, "youtubeSignupRequired"), "auth"], [() => youtubeError(403, "quotaExceeded"), "other"], [() => new Response(null, { status: 500 }), "other"]] as const) {
    fake.answer(answer);
    expect(await ask("social.health")).toEqual({ ok: false, reason });
  }
  fake.answer(() => Response.json({ items: [] }));
  expect(await ask("social.health")).toEqual({ ok: true });
});

test("no token in any error or logged line", async () => {
  fake.answer(() => new Response("ya29-secret", { status: 500 }));
  await expect(ask("social.identity")).rejects.not.toThrow(/ya29/);
  await ask("social.health");
  expect(logged.join("\n")).not.toContain("ya29");
});

test("it holds only the two queries and reaches only Google's API host", () => {
  expect(p.manifest.capabilities.map((c) => [c.kind, c.name])).toEqual([["query", "social.identity"], ["query", "social.health"]]);
  expect(p.manifest.egress.hosts).toEqual(["www.googleapis.com"]);
});
