// SPDX-License-Identifier: AGPL-3.0-only
// The links a plugin reads an approved file through: only the approved bytes, only for a few minutes,
// and no sign-in, so the token alone must hold.
import type { OpenAPIHono } from "@hono/zod-openapi";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { linkToken, readLinkToken, LINK_MS } from "./application/link-token";
import { TEST_SECRET, testIdentity } from "./fixtures/support";
import { createMedia, diskStore, mediaRoutes } from "./index";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;
const dir = await mkdtemp(join(tmpdir(), "direx-media-links-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
let clock = new Date("2026-11-06T12:00:00Z");
const SECRET = "s".repeat(32);
const files = createMedia({ store: () => diskStore(dir), now: () => clock, links: { baseUrl: () => "https://direx.example", secret: () => SECRET } });
const { routes, signIn, createOrg } = testIdentity();
(routes as unknown as OpenAPIHono).route("/", mediaRoutes({ media: () => files }));

const owner = await signIn();
const W = (await createOrg(owner, "Links")).workspace.id;
const mp4 = (size: number, seed = 0) => {
  const b = new Uint8Array(size);
  b.set([0, 0, 0, 0x20, ...new TextEncoder().encode("ftypisom")]);
  for (let i = 12; i < size; i++) b[i] = (i + seed) % 251;
  return b;
};
const put = async (bytes: Uint8Array<ArrayBuffer>) => {
  const r = await routes.request(`/api/w/${W}/media?kind=clip`, { method: "POST", headers: { cookie: owner }, body: bytes });
  return ((await r.json()) as { media: { id: string } }).media.id;
};
const open = (url: string, headers: Record<string, string> = {}) => routes.request(url.replace("https://direx.example", ""), { headers });

test("a link serves the approved file, in ranges, with no sign-in, until it ends", async () => {
  clock = new Date("2026-11-06T12:00:00Z");
  const bytes = mp4(500);
  const id = await put(bytes);
  const ref = (await files.ref(W, id))!;
  expect(ref).toMatchObject({ mediaId: id, bytes: 500, contentType: "video/mp4" });
  const link = (await files.link(W, ref))!;
  expect(link).toMatchObject({ bytes: 500, sha256: ref.sha256, contentType: "video/mp4" });
  expect(link.url).toMatch(/^https:\/\/direx\.example\/api\/media-links\//);

  const whole = await open(link.url);
  expect(whole.status).toBe(200);
  expect(new Uint8Array(await whole.arrayBuffer())).toEqual(bytes);
  const part = await open(link.url, { range: "bytes=10-19" });
  expect(part.status).toBe(206);
  expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(10, 20));

  clock = new Date(clock.getTime() + LINK_MS + 1000);
  expect((await open(link.url)).status).toBe(404);
});

test("no link for a file deleted or changed since approval", async () => {
  clock = new Date("2026-11-06T12:00:00Z");
  const id = await put(mp4(300));
  const ref = (await files.ref(W, id))!;
  expect(await files.link(W, { ...ref, sha256: "0".repeat(64) })).toBeNull();
  expect(await files.link(W, { ...ref, bytes: 301 })).toBeNull();
  const link = (await files.link(W, ref))!;
  await files.remove(W, id);
  expect(await files.link(W, ref)).toBeNull();
  expect(await files.ref(W, id)).toBeNull();
  // A link given out before the delete stops working too.
  expect((await open(link.url)).status).toBe(404);
});

test("an altered, foreign or malformed token opens nothing", async () => {
  clock = new Date("2026-11-06T12:00:00Z");
  const id = await put(mp4(200));
  const other = await put(mp4(200, 7));
  const good = linkToken(SECRET, W, id, clock);
  const [ws, , until, mac] = good.split(".");
  for (const token of [`${ws}.${other}.${until}.${mac}`, `${ws}.${id}.${Number(until) + 60}.${mac}`, linkToken("t".repeat(32), W, id, clock), `${good}.x`, "nonsense", `${ws}.${id}.soon.${mac}`]) {
    expect((await routes.request(`/api/media-links/${token}`)).status).toBe(404);
  }
  expect(readLinkToken(SECRET, good, clock)).toEqual({ workspaceId: W, mediaId: id });
  expect((await routes.request(`/api/media-links/${good}`)).status).toBe(200);
});

test("without a deployment address, disk links can't be made and tokens open nothing", async () => {
  const bare = createMedia({ store: () => diskStore(dir), now: () => clock });
  const id = await put(mp4(100));
  const ref = (await bare.ref(W, id))!;
  await expect(bare.link(W, ref)).rejects.toThrow("links need");
  expect(await bare.readLink(linkToken(SECRET, W, id, clock))).toBeNull();
});
