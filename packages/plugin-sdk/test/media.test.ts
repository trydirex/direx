// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { definePlugin, MediaMismatch, mediaRefs, parseManifest, streamParts, type CallContext, type MediaLink } from "../src/index";
import { invoke } from "../src/host";

const bytes = new Uint8Array(10_000).map((_, i) => i % 251);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
let served = bytes;
// Small chunks, so parts are assembled across chunk edges.
const server = Bun.serve({
  port: 0,
  fetch: () =>
    new Response(
      new ReadableStream({
        start(c) {
          for (let i = 0; i < served.length; i += 777) c.enqueue(served.slice(i, i + 777));
          c.close();
        },
      }),
    ),
});
afterAll(() => server.stop(true));
const link = (over: Partial<MediaLink> = {}): MediaLink => ({ url: `http://localhost:${server.port}/f`, bytes: bytes.length, sha256: sha(bytes), contentType: "video/mp4", ...over });

const collect = async (l: MediaLink, size: number) => {
  const parts: Uint8Array[] = [];
  for await (const p of streamParts(l, size)) parts.push(p);
  return parts;
};

test("parts are the given size, the last shorter, and together are the file", async () => {
  served = bytes;
  const parts = await collect(link(), 4096);
  expect(parts.map((p) => p.length)).toEqual([4096, 4096, 1808]);
  expect(sha(Buffer.concat(parts))).toBe(sha(bytes));
});

test("other bytes, a longer file or a shorter one throw before the last part is handed over", async () => {
  served = bytes.map((b, i) => (i === 9_999 ? b ^ 1 : b));
  await expect(collect(link(), 4096)).rejects.toBeInstanceOf(MediaMismatch);
  served = bytes;
  await expect(collect(link({ bytes: 9_000 }), 4096)).rejects.toBeInstanceOf(MediaMismatch);
  await expect(collect(link({ bytes: 11_000 }), 4096)).rejects.toBeInstanceOf(MediaMismatch);
});

test("a failed read throws", async () => {
  const notFound = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
  await expect(streamParts(link(), 10, notFound).next()).rejects.toThrow("404");
});

test("only a well-formed media array at the top of a spec names files", () => {
  const ref = { mediaId: randomUUID(), sha256: sha(bytes), bytes: 1, contentType: "video/mp4" };
  expect(mediaRefs({ media: [ref] })).toEqual([ref]);
  expect(mediaRefs({ text: "hi" })).toEqual([]);
  expect(mediaRefs({ media: [{ ...ref, sha256: "x" }] })).toEqual([]);
  expect(mediaRefs({ nested: { media: [ref] } })).toEqual([]);
  expect(mediaRefs(null)).toEqual([]);
});

const manifest = {
  id: "com.example.video",
  apiVersion: 1,
  version: "1.0.0",
  minHostVersion: "0.1.0",
  trust: "third_party",
  connections: [{ key: "v", auth: "none" }],
  egress: { hosts: [] },
  capabilities: [{ kind: "effect", name: "video.post", connection: "v", dedupe: "blind", risk: "low", reachesPerson: false, media: "read" }],
};

test("the manifest takes media read and nothing else", () => {
  expect(parseManifest(manifest)).toMatchObject({ ok: true });
  const write = { ...manifest, capabilities: [{ ...manifest.capabilities[0], media: "write" }] };
  expect(parseManifest(write)).toMatchObject({ ok: false });
});

test("execute hands the plugin the links the host sent, and none when it sent none", async () => {
  const seen: CallContext["media"][] = [];
  const plugin = definePlugin({ manifest, effects: { "video.post": { prepare: async () => ({ spec: {}, preview: "" }), execute: async (_s, ctx) => (seen.push(ctx.media), { kind: "sent" }) } } });
  const ctx = { workspaceId: "w", log: () => undefined };
  const id = randomUUID();
  await invoke(plugin, "execute", { capability: "video.post", spec: {}, idempotencyKey: "k", credential: null, media: { [id]: link() } }, ctx);
  await invoke(plugin, "execute", { capability: "video.post", spec: {}, idempotencyKey: "k", credential: null }, ctx);
  expect(seen).toEqual([{ [id]: link() }, {}]);
});
