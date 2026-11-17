// SPDX-License-Identifier: AGPL-3.0-only
// Image posts against fakes written from each network's docs: what is refused at draft, and the upload and
// post at publish. Nothing is posted with bytes other than the approved ones, and a network that takes no
// images refuses them at draft rather than posting the text alone.
import { type MediaLink, type MediaRef, type Plugin } from "@direx/plugin-sdk";
import { invoke } from "../test-wire";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { fakeBluesky } from "./bluesky/fake-bluesky";
import { createBlueskyPlugin } from "./bluesky/plugin";
import { fakeLinkedIn } from "./linkedin/fake-linkedin";
import { createLinkedInPlugin } from "./linkedin/plugin";
import { createThreadsPlugin } from "./threads/plugin";
import { createXPlugin } from "./x/plugin";

const png = new Uint8Array(20_000).map((_, i) => (i < 8 ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][i]! : i % 251));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
let served: Uint8Array<ArrayBuffer> = png;
const files = Bun.serve({ port: 0, fetch: () => new Response(served) });
const li = fakeLinkedIn();
const bsky = fakeBluesky();
afterAll(() => {
  files.stop(true);
  li.stop();
  bsky.stop();
});
beforeEach(() => {
  li.reset();
  bsky.reset();
  served = png;
});

const ctx = { workspaceId: "w", log: () => undefined };
const token = { accessToken: "T", expiresAt: "2030-01-01T00:00:00.000Z" };
const image = (over: Partial<MediaRef> = {}): MediaRef => ({ mediaId: randomUUID(), sha256: sha(png), bytes: png.length, contentType: "image/png", ...over });
const linkOf = (r: MediaRef): MediaLink => ({ url: `http://localhost:${files.port}/f`, sha256: r.sha256, bytes: r.bytes, contentType: r.contentType });
const prepare = (p: Plugin, media: MediaRef[], alt?: string[]) =>
  invoke(p, "prepare", { capability: "social.publish", input: { text: "look", followUps: [], target: "me", links: true, media, ...(alt && { alt }) } }, ctx) as Promise<{ spec: Record<string, unknown> }>;
type Result = { kind: string; retryable?: boolean; detail?: string };
const execute = (p: Plugin, refs: MediaRef[], alt: string[], credential: unknown = token) =>
  invoke(p, "execute", { capability: "social.publish", spec: { text: "look", followUps: [], target: "me", media: refs, alt }, idempotencyKey: "k", credential, media: Object.fromEntries(refs.map((r) => [r.mediaId, linkOf(r)])) }, ctx) as Promise<Result>;

describe("at draft", () => {
  const p = createLinkedInPlugin({ baseUrl: li.url, timeoutMs: 2000 });
  test("an image post keeps its images in order with their alt text, trimmed, and empty where none was written", async () => {
    const [a, b] = [image(), image()];
    expect((await prepare(p, [a, b], [" A chart "])).spec).toEqual({ text: "look", followUps: [], target: "me", media: [a, b], alt: ["A chart", ""] });
  });
  test("what a network won't take is refused in the person's words, and so is a video with images", async () => {
    await expect(prepare(p, [image({ contentType: "image/webp" })])).rejects.toThrow("LinkedIn takes JPEG, PNG, GIF images up to 10 MB; this image is WebP");
    await expect(prepare(p, [image(), image({ bytes: 12_000_000 })])).rejects.toThrow("image 2 is 12 MB");
    await expect(prepare(p, Array.from({ length: 5 }, () => image()))).rejects.toThrow();
    await expect(prepare(p, [image(), { ...image(), contentType: "video/mp4" }])).rejects.toThrow("a post carries a video or images, not both");
    await expect(prepare(createBlueskyPlugin({ baseUrl: bsky.url, timeoutMs: 2000 }), [image({ bytes: 1_200_000 })])).rejects.toThrow("Bluesky takes JPEG, PNG, WebP images up to 1 MB; this image is 1.2 MB");
  });
  test("a network whose plugin takes no images refuses them, so the text never goes out alone", async () => {
    await expect(prepare(createXPlugin({ baseUrl: li.url, timeoutMs: 2000 }), [image()])).rejects.toThrow("this network takes no images here");
    await expect(prepare(createThreadsPlugin({ baseUrl: li.url, timeoutMs: 2000 }), [image()])).rejects.toThrow("this network takes no images here");
  });
});

describe("LinkedIn", () => {
  const p = createLinkedInPlugin({ baseUrl: li.url, timeoutMs: 2000 });
  test("one image uploads and posts as media with its alt text", async () => {
    expect(await execute(p, [image()], ["A chart"])).toMatchObject({ kind: "sent" });
    expect(JSON.parse(li.calls[0]!.body)).toEqual({ initializeUploadRequest: { owner: "urn:li:person:me" } });
    expect(li.calls.find((c) => c.path.startsWith("/upload/"))).toMatchObject({ method: "PUT", bytes: png.length });
    expect(JSON.parse(li.calls.at(-1)!.body).content).toEqual({ media: { id: "urn:li:image:I1", altText: "A chart" } });
  });
  test("several post as multiImage in order, and no alt text is left out rather than sent empty", async () => {
    expect(await execute(p, [image(), image()], ["First", ""])).toMatchObject({ kind: "sent" });
    expect(JSON.parse(li.calls.at(-1)!.body).content).toEqual({ multiImage: { images: [{ id: "urn:li:image:I1", altText: "First" }, { id: "urn:li:image:I2" }] } });
  });
  test("bytes that aren't the approved ones are held and nothing is posted", async () => {
    served = png.map((b, i) => (i === 9 ? b ^ 1 : b));
    expect(await execute(p, [image()], [""])).toMatchObject({ kind: "refused", retryable: false, detail: "an image is not the one approved, so it was not posted" });
    expect(li.paths()).not.toContain("/rest/posts");
  });
});

describe("Bluesky", () => {
  const p = createBlueskyPlugin({ baseUrl: bsky.url, timeoutMs: 2000 });
  const password = { username: "ana.bsky.social", password: "abcd-efgh-ijkl-mnop" };
  test("each image uploads as a blob, and the post embeds them in order with their alt text", async () => {
    expect(await execute(p, [image(), image()], ["A chart", ""], password)).toMatchObject({ kind: "sent" });
    const blobs = bsky.calls.filter((c) => c.path.endsWith("uploadBlob"));
    expect(blobs.map((c) => [c.bytes, c.auth])).toEqual([[png.length, "Bearer jwt"], [png.length, "Bearer jwt"]]);
    const record = JSON.parse(bsky.calls.find((c) => c.path.endsWith("createRecord"))!.body).record;
    expect(record.embed.$type).toBe("app.bsky.embed.images");
    expect(record.embed.images.map((i: { alt: string; image: { mimeType: string } }) => [i.alt, i.image.mimeType])).toEqual([["A chart", "image/png"], ["", "image/png"]]);
  });
});
