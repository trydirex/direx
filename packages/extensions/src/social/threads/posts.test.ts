// SPDX-License-Identifier: AGPL-3.0-only
// The Threads social.posts reader against its fake. Shapes come from Threads' retrieval docs.
import { type Plugin } from "@direx/plugin-sdk";
import { afterAll, beforeEach, expect, test } from "vitest";
import { invoke } from "../../test-wire";
import { fakeThreads } from "./fake-threads";
import { createThreadsPlugin } from "./plugin";

type Out = { posts: { id: string; kind: string; createdAt: string }[]; next?: string; newest?: string };
const read = async (p: Plugin, input: unknown, credential: unknown) => ((await invoke(p, "query", { capability: "social.posts", input, credential }, { workspaceId: "w", log: () => undefined })) as { output: Out }).output;
const ids = (o: Out) => o.posts.map((x) => x.id);

const t = fakeThreads();
afterAll(() => t.stop());
beforeEach(() => t.reset());

const threads = createThreadsPlugin({ baseUrl: t.url, timeoutMs: 1000 });
const token = { accessToken: "tok", expiresAt: "2030-01-01T00:00:00.000Z" };
const media = (id: string, timestamp: string, more: object = {}) => ({ id, timestamp, text: `own ${id}`, permalink: `https://www.threads.com/@ana/post/${id}`, media_type: "TEXT_POST", is_quote_post: false, ...more });

test("Threads: kinds, UTC times and the attached link, as the account's own", async () => {
  t.media.push(
    media("m4", "2026-11-20T12:00:00+0000", { media_type: "REPOST_FACADE", text: undefined }),
    media("m3", "2026-11-20T11:00:00+0000", { is_quote_post: true }),
    media("m2", "2026-11-20T12:00:00+0200", { link_attachment_url: "https://a.example/x" }),
    media("m1", "2026-11-20T09:00:00+0000", { link_attachment_url: "ftp://files.example/f", permalink: "javascript:alert(1)" }),
  );
  const out = await read(threads, { limit: 10 }, token);
  expect(out.posts).toEqual([
    { id: "m4", accountId: "5", kind: "repost", createdAt: "2026-11-20T12:00:00.000Z", text: "", links: [], permalink: "https://www.threads.com/@ana/post/m4" },
    { id: "m3", accountId: "5", kind: "quote", createdAt: "2026-11-20T11:00:00.000Z", text: "own m3", links: [], permalink: "https://www.threads.com/@ana/post/m3" },
    { id: "m2", accountId: "5", kind: "original", createdAt: "2026-11-20T10:00:00.000Z", text: "own m2", links: ["https://a.example/x"], permalink: "https://www.threads.com/@ana/post/m2" },
    { id: "m1", accountId: "5", kind: "original", createdAt: "2026-11-20T09:00:00.000Z", text: "own m1", links: [] },
  ]);
  expect(t.paths()).toEqual(["/v1.0/me", "/v1.0/me/threads"]);
  expect(Object.fromEntries(new URL(t.calls[1]!.path, t.url).searchParams)).toEqual({ fields: "id,text,timestamp,permalink,media_type,is_quote_post,link_attachment_url", limit: "10" });
});

test("Threads: next pages back, and a later read passes since and returns only newer posts", async () => {
  t.media.push(media("c", "2026-11-03T00:00:00+0000"), media("b", "2026-11-02T00:00:00+0000"), media("a", "2026-11-01T00:00:00+0000"));
  const first = await read(threads, { limit: 2 }, token);
  expect(ids(first)).toEqual(["c", "b"]);
  const back = await read(threads, { cursor: first.next, limit: 2 }, token);
  expect(ids(back)).toEqual(["a"]);
  expect(back.newest).toBeUndefined();
  expect((await read(threads, { cursor: back.next, limit: 2 }, token)).next).toBeUndefined();

  t.media.unshift(media("e", "2026-11-05T00:00:00+0000"), media("d", "2026-11-04T00:00:00+0000"));
  const later = await read(threads, { cursor: first.newest, limit: 1 }, token);
  expect(ids(later)).toEqual(["e"]);
  expect(new URL(t.calls.at(-1)!.path, t.url).searchParams.get("since")).toBe(String(Date.parse("2026-11-03T00:00:00Z") / 1000));
  const rest = await read(threads, { cursor: later.next, limit: 5 }, token);
  // The fake's since includes the old newest itself; the reader drops it.
  expect(ids(rest)).toEqual(["d"]);
  expect(JSON.parse(later.newest!)).toEqual({ since: "2026-11-05T00:00:00.000Z" });
});

test("Threads: a lookup leaves out a post that no longer exists", async () => {
  t.media.push(media("m1", "2026-11-01T00:00:00+0000"));
  const out = await read(threads, { ids: ["m1", "gone"] }, token);
  expect(ids(out)).toEqual(["m1"]);
  expect(t.paths()).toEqual(["/v1.0/me", "/v1.0/m1", "/v1.0/gone"]);
});

test("Threads: a lookup rejects code 100 without a deletion subcode", async () => {
  t.failNext.push(Response.json({ id: "5" }), Response.json({ error: { code: 100 } }, { status: 400 }));
  await expect(read(threads, { ids: ["m1"] }, token)).rejects.toMatchObject({ reason: "provider_error", status: 400, networkCode: 100 });
  expect(t.paths()).toEqual(["/v1.0/me", "/v1.0/m1"]);
});

test("Threads: 190 asks for a reconnect, 4 waits, and anything else is the network's error", async () => {
  t.failNext.push(Response.json({ error: { code: 190 } }, { status: 400 }), Response.json({ error: { code: 4 } }, { status: 400 }), Response.json({ error: { code: 1 } }, { status: 500 }), Response.json({}, { status: 404 }));
  await expect(read(threads, { limit: 5 }, token)).rejects.toMatchObject({ reason: "credential_rejected", status: 400 });
  await expect(read(threads, { limit: 5 }, token)).rejects.toMatchObject({ reason: "rate_limited" });
  await expect(read(threads, { limit: 5 }, token)).rejects.toMatchObject({ reason: "provider_error", status: 500, networkCode: 1 });
  await expect(read(threads, { limit: 5 }, token)).rejects.toMatchObject({ reason: "not_found" });
  for (const cursor of ["{\"after\":1}", "not ours"]) await expect(read(threads, { cursor, limit: 5 }, token)).rejects.toMatchObject({ reason: "invalid_params" });
  await expect(read(threads, { ids: [] }, token)).rejects.toMatchObject({ reason: "invalid_params" });
  await expect(read(threads, { limit: 5 }, null)).rejects.toMatchObject({ reason: "not_connected" });
});
