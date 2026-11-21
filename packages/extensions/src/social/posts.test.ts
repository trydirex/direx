// SPDX-License-Identifier: AGPL-3.0-only
// The Bluesky social.posts reader against its fake. Shapes come from Bluesky's lexicons.
import { type Plugin } from "@direx/plugin-sdk";
import { afterAll, beforeEach, expect, test } from "vitest";
import { invoke } from "../test-wire";
import { fakeBluesky } from "./bluesky/fake-bluesky";
import { createBlueskyPlugin } from "./bluesky/plugin";

type Out = { posts: { id: string; kind: string; createdAt: string }[]; next?: string; newest?: string };
const read = async (p: Plugin, input: unknown, credential: unknown) => ((await invoke(p, "query", { capability: "social.posts", input, credential }, { workspaceId: "w", log: () => undefined })) as { output: Out }).output;
const ids = (o: Out) => o.posts.map((x) => x.id);

const b = fakeBluesky();
afterAll(() => b.stop());
beforeEach(() => b.reset());

const bsky = createBlueskyPlugin({ baseUrl: b.url, appViewUrl: b.url, timeoutMs: 1000 });
const login = { username: " @ana.bsky.social", password: "abcd-efgh-ijkl-mnop" };
const did = "did:plc:ana";
const uri = (rkey: string) => `at://${did}/app.bsky.feed.post/${rkey}`;
const item = (rkey: string, at: string, record: object = {}) => ({ post: { uri: uri(rkey), author: { did }, indexedAt: at, record: { text: `own ${rkey}`, createdAt: at, ...record } } });
const link = (u: string) => ({ features: [{ $type: "app.bsky.richtext.facet#link", uri: u }] });

test("Bluesky: kinds, UTC times and web links, read from the public AppView with no session", async () => {
  const shared = { post: { uri: "at://did:plc:bob/app.bsky.feed.post/b1", author: { did: "did:plc:bob" }, indexedAt: "2026-11-20T09:00:00.000Z", record: { text: "Bob's", createdAt: "2026-11-20T09:00:00.000Z", reply: {} } } };
  b.feed.push(
    { ...shared, reason: { $type: "app.bsky.feed.defs#reasonRepost", uri: `at://${did}/app.bsky.feed.repost/x1`, by: { did }, indexedAt: "2026-11-20T12:00:00.000Z" } },
    item("q1", "2026-11-20T11:00:00.000Z", { embed: { $type: "app.bsky.embed.record", record: { uri: "at://did:plc:bob/app.bsky.feed.post/b1" } } }),
    item("q2", "2026-11-20T10:30:00.000Z", { embed: { $type: "app.bsky.embed.recordWithMedia", record: {}, media: { $type: "app.bsky.embed.external", external: { uri: "https://media.example/a" } } } }),
    item("r1", "2026-11-20T10:15:00.000Z", { reply: { root: {}, parent: {} } }),
    item("o1", "2026-11-20T10:00:00.000Z", {
      createdAt: "2026-11-20T12:00:00+02:00",
      facets: [link("https://a.example/x"), { features: [{ $type: "app.bsky.richtext.facet#mention", did }] }, link("ftp://files.example/f"), link("https://a.example/x")],
      embed: { $type: "app.bsky.embed.external", external: { uri: "http://card.example/" } },
    }),
  );
  const out = await read(bsky, { limit: 10 }, login);
  expect(out.posts).toEqual([
    { id: `at://${did}/app.bsky.feed.repost/x1`, accountId: did, kind: "repost", createdAt: "2026-11-20T12:00:00.000Z", text: "", links: [], permalink: "https://bsky.app/profile/did:plc:bob/post/b1" },
    { id: uri("q1"), accountId: did, kind: "quote", createdAt: "2026-11-20T11:00:00.000Z", text: "own q1", links: [], permalink: `https://bsky.app/profile/${did}/post/q1` },
    { id: uri("q2"), accountId: did, kind: "quote", createdAt: "2026-11-20T10:30:00.000Z", text: "own q2", links: ["https://media.example/a"], permalink: `https://bsky.app/profile/${did}/post/q2` },
    { id: uri("r1"), accountId: did, kind: "reply", createdAt: "2026-11-20T10:15:00.000Z", text: "own r1", links: [], permalink: `https://bsky.app/profile/${did}/post/r1` },
    { id: uri("o1"), accountId: did, kind: "original", createdAt: "2026-11-20T10:00:00.000Z", text: "own o1", links: ["https://a.example/x", "http://card.example/"], permalink: `https://bsky.app/profile/${did}/post/o1` },
  ]);
  expect(out.next).toBeUndefined();
  expect(JSON.parse(out.newest!)).toEqual({ since: "2026-11-20T12:00:00.000Z" });
  expect(b.paths()).toEqual(["/xrpc/app.bsky.feed.getAuthorFeed"]);
  expect(Object.fromEntries(new URL(b.calls[0]!.path, b.url).searchParams)).toEqual({ actor: "ana.bsky.social", filter: "posts_no_replies", limit: "10" });
  expect(b.calls[0]!.auth).toBeNull();
});

test("Bluesky: next pages back, and a later read from newest returns only newer posts", async () => {
  b.feed.push(item("c", "2026-11-03T00:00:00.000Z"), item("b", "2026-11-02T00:00:00.000Z"), item("a", "2026-11-01T00:00:00.000Z"));
  const first = await read(bsky, { limit: 2 }, login);
  expect(ids(first)).toEqual([uri("c"), uri("b")]);
  const back = await read(bsky, { cursor: first.next, limit: 2 }, login);
  expect(ids(back)).toEqual([uri("a")]);
  expect(back.next).toBeUndefined();
  expect(back.newest).toBeUndefined();

  b.feed.unshift(item("f", "2026-11-06T00:00:00.000Z"), item("e", "2026-11-05T00:00:00.000Z"), item("d", "2026-11-04T00:00:00.000Z"));
  const later = await read(bsky, { cursor: first.newest, limit: 2 }, login);
  expect(ids(later)).toEqual([uri("f"), uri("e")]);
  expect(JSON.parse(later.newest!)).toEqual({ since: "2026-11-06T00:00:00.000Z" });
  // The page was all new, so next goes on and still stops at the old newest.
  const rest = await read(bsky, { cursor: later.next, limit: 2 }, login);
  expect(ids(rest)).toEqual([uri("d")]);
  expect(rest.next).toBeUndefined();
  const none = await read(bsky, { cursor: later.newest, limit: 2 }, login);
  expect(none.posts).toEqual([]);
  expect(none.newest).toBe(later.newest);
  expect(b.paths()).not.toContain("/xrpc/com.atproto.server.createSession");
});

test("Bluesky: a lookup asks 25 uris at a time and leaves out a deleted one", async () => {
  for (let i = 0; i < 26; i++) b.feed.push(item(`p${i}`, "2026-11-01T00:00:00.000Z"));
  const asked = [...b.feed.map((f) => f.post.uri), uri("deleted")];
  const out = await read(bsky, { ids: asked }, null);
  expect(ids(out)).toEqual(asked.slice(0, 26));
  expect(b.calls.map((c) => new URL(c.path, b.url).searchParams.getAll("uris").length)).toEqual([25, 2]);
  expect(b.paths()).toEqual(["/xrpc/app.bsky.feed.getPosts", "/xrpc/app.bsky.feed.getPosts"]);
});

test("Bluesky: a 429 waits as told, other refusals map by status, and bad input is refused", async () => {
  const reset = Math.floor(Date.now() / 1000) + 60;
  b.failNext.push(new Response(null, { status: 429, headers: { "ratelimit-reset": String(reset) } }));
  const e = (await read(bsky, { limit: 5 }, login).catch((x: unknown) => x)) as { reason: string; waitMs: number };
  expect(e.reason).toBe("rate_limited");
  expect(e.waitMs).toBeGreaterThan(55_000);
  expect(e.waitMs).toBeLessThanOrEqual(60_000);
  b.failNext.push(new Response(null, { status: 429, headers: { "retry-after": "30" } }), new Response(null, { status: 429 }), new Response(null, { status: 400 }));
  await expect(read(bsky, { limit: 5 }, login)).rejects.toMatchObject({ reason: "rate_limited", waitMs: 30_000 });
  await expect(read(bsky, { ids: [uri("x")] }, null)).rejects.toMatchObject({ reason: "rate_limited", waitMs: undefined });
  await expect(read(bsky, { limit: 5 }, login)).rejects.toMatchObject({ reason: "provider_error", status: 400 });
  await expect(read(bsky, { limit: 0 }, login)).rejects.toMatchObject({ reason: "invalid_params" });
  await expect(read(bsky, { cursor: "not ours", limit: 5 }, login)).rejects.toMatchObject({ reason: "invalid_params" });
  await expect(read(bsky, { limit: 5 }, null)).rejects.toMatchObject({ reason: "not_connected" });
});
