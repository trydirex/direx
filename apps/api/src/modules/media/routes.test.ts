// SPDX-License-Identifier: AGPL-3.0-only
// Upload, read and delete over HTTP, on the disk store, with a small cap so the edges are cheap to test.
import type { OpenAPIHono } from "@hono/zod-openapi";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { mediaRows, TEST_SECRET, testIdentity } from "./fixtures/support";
import { createMedia, diskStore, IMAGE_MAX_BYTES, mediaRoutes } from "./index";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;
const dir = await mkdtemp(join(tmpdir(), "direx-media-routes-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const CAP = 1000;
const files = createMedia({ store: () => diskStore(dir), now: () => new Date("2026-11-06T12:00:00Z"), maxBytes: CAP });
const { routes, signIn, createOrg, addMember } = testIdentity();
(routes as unknown as OpenAPIHono).route("/", mediaRoutes({ media: () => files }));

const owner = await signIn();
const W = (await createOrg(owner, "Media")).workspace.id;
const other = await signIn();
const W2 = (await createOrg(other, "Other")).workspace.id;

const mp4 = (size: number) => {
  const b = new Uint8Array(size);
  b.set([0, 0, 0, 0x20, ...new TextEncoder().encode("ftypisom")]);
  for (let i = 12; i < size; i++) b[i] = i % 251;
  return b;
};
const upload = (body: Uint8Array<ArrayBuffer>, cookie = owner, name = encodeURIComponent("Webinar — Nov.mp4")) =>
  routes.request(`/api/w/${W}/media?kind=source`, { method: "POST", headers: { cookie, "content-type": "video/mp4", "x-file-name": name }, body });
const get = (id: string, cookie = owner, headers: Record<string, string> = {}) => routes.request(`/api/w/${W}/media/${id}`, { headers: { cookie, ...headers } });
const rows = () => mediaRows(W);
const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

test("a video at the cap is stored with its size and hash, and reads back whole", async () => {
  const bytes = mp4(CAP);
  const r = await upload(bytes);
  expect(r.status).toBe(201);
  const { media: m } = (await r.json()) as { media: { id: string; bytes: number; contentType: string; fileName: string; kind: string } };
  expect(m).toMatchObject({ bytes: CAP, contentType: "video/mp4", fileName: "Webinar — Nov.mp4", kind: "source" });
  expect((await rows()).find((x) => x.id === m.id)?.sha256).toBe(sha(bytes));
  const read = await get(m.id);
  expect(read.status).toBe(200);
  expect(read.headers.get("content-type")).toBe("video/mp4");
  expect(read.headers.get("accept-ranges")).toBe("bytes");
  expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);
});

test("one byte over the cap, or a file that isn't a video, leaves no bytes and no row", async () => {
  const before = (await rows()).length;
  const over = await upload(mp4(CAP + 1));
  expect(over.status).toBe(413);
  expect(await over.json()).toEqual({ error: "too_large" });
  const noise = new Uint8Array(100).fill(0xff);
  const notVideo = await upload(noise);
  expect(notVideo.status).toBe(415);
  expect(await notVideo.json()).toEqual({ error: "not_supported" });
  // A declared length over the cap is refused before a byte is read.
  const declared = await routes.request(`/api/w/${W}/media?kind=source`, { method: "POST", headers: { cookie: owner, "content-length": String(CAP + 1) }, body: mp4(100) });
  expect(declared.status).toBe(413);
  const empty = await upload(new Uint8Array());
  expect(empty.status).toBe(415);
  expect((await rows()).length).toBe(before);
  expect((await readdir(join(dir, W))).filter((f) => f.endsWith(".part"))).toEqual([]);
  expect(await readdir(join(dir, W))).toHaveLength(before);
});

test("a post's image is kept as what its bytes are, and an image over 10 MB is refused where a video that size isn't", async () => {
  const png = new Uint8Array(500);
  png.set([0x89, ...new TextEncoder().encode("PNG\r\n\x1a\n"), 0, 0, 0]);
  const r = await routes.request(`/api/w/${W}/media?kind=clip`, { method: "POST", headers: { cookie: owner, "content-type": "video/mp4", "x-file-name": "chart.png" }, body: png });
  expect(r.status).toBe(201);
  const { media: m } = (await r.json()) as { media: { id: string; contentType: string } };
  expect(m.contentType).toBe("image/png");
  expect((await get(m.id)).headers.get("content-type")).toBe("image/png");

  const big = createMedia({ store: () => diskStore(dir), now: () => new Date("2026-11-06T12:00:00Z") });
  const stream = (head: number[], size: number) => {
    const b = new Uint8Array(size);
    b.set(head);
    return new Blob([b]).stream();
  };
  const at = { workspaceId: W, userId: (await rows())[0]!.uploadedBy, kind: "clip" as const, fileName: "x", declaredBytes: undefined };
  const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d];
  expect(await big.upload({ ...at, body: stream(PNG_HEAD, IMAGE_MAX_BYTES + 1) })).toEqual({ ok: false, reason: "too_large" });
  expect(await big.upload({ ...at, declaredBytes: IMAGE_MAX_BYTES + 1, body: stream(PNG_HEAD, 100) })).toEqual({ ok: false, reason: "too_large" });
  expect((await big.upload({ ...at, body: stream([...mp4(12)], IMAGE_MAX_BYTES + 1) })).ok).toBe(true);
});

test("a player seeks with a range", async () => {
  const bytes = mp4(500);
  const { media: m } = (await (await upload(bytes)).json()) as { media: { id: string } };
  const part = await get(m.id, owner, { range: "bytes=100-199" });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toBe("bytes 100-199/500");
  expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(100, 200));
  expect((await get(m.id, owner, { range: "bytes=900-" })).status).toBe(416);
});

test("a deleted file is gone to readers; deleting twice is a 404", async () => {
  const { media: m } = (await (await upload(mp4(200))).json()) as { media: { id: string } };
  const del = () => routes.request(`/api/w/${W}/media/${m.id}`, { method: "DELETE", headers: { cookie: owner } });
  expect((await del()).status).toBe(204);
  expect((await get(m.id)).status).toBe(404);
  expect((await del()).status).toBe(404);
  expect((await rows()).find((x) => x.id === m.id)?.deletedAt).toEqual(new Date("2026-11-06T12:00:00Z"));
});

test("another Workspace can't read or delete a file by its id", async () => {
  const { media: m } = (await (await upload(mp4(200))).json()) as { media: { id: string } };
  expect((await routes.request(`/api/w/${W2}/media/${m.id}`, { headers: { cookie: other } })).status).toBe(404);
  expect((await routes.request(`/api/w/${W2}/media/${m.id}`, { method: "DELETE", headers: { cookie: other } })).status).toBe(404);
  expect((await get(m.id)).status).toBe(200);
});

test("a viewer reads but can't upload or delete; no session gets nothing", async () => {
  const { media: m } = (await (await upload(mp4(200))).json()) as { media: { id: string } };
  const viewer = (await addMember(owner, W, "viewer")).cookie;
  expect((await upload(mp4(200), viewer)).status).toBe(403);
  expect((await routes.request(`/api/w/${W}/media/${m.id}`, { method: "DELETE", headers: { cookie: viewer } })).status).toBe(403);
  expect((await get(m.id, viewer)).status).toBe(200);
  expect((await routes.request(`/api/w/${W}/media/${m.id}`)).status).toBe(401);
});

test("a bad kind is refused; a missing file name becomes 'upload'", async () => {
  const r = await routes.request(`/api/w/${W}/media?kind=poster`, { method: "POST", headers: { cookie: owner }, body: mp4(100) });
  expect(r.status).toBe(400);
  const noName = await upload(mp4(100), owner, "");
  expect(noName.status).toBe(201);
  expect(((await noName.json()) as { media: { fileName: string } }).media.fileName).toBe("upload");
});
