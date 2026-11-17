// SPDX-License-Identifier: AGPL-3.0-only
// The daily sweep: sources go after 7 days, deleted files lose their bytes, clips stay.
// The clock sits in 2000, so the sweep never marks another test file's rows as old.
import type { OpenAPIHono } from "@hono/zod-openapi";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { createMedia, diskStore, mediaRoutes, type Store } from "./index";
import { mediaRows, TEST_SECRET, testIdentity } from "./fixtures/support";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;
const dir = await mkdtemp(join(tmpdir(), "direx-media-sweep-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const clock = { at: new Date("2000-01-01T00:00:00Z") };
const failOn = new Set<string>();
const disk = diskStore(dir);
const store: Store = {
  ...disk,
  remove: (key) => (failOn.has(key) ? Promise.reject(new Error("disk said no")) : disk.remove(key)),
};
const files = createMedia({ store: () => store, now: () => clock.at });
const { routes, signIn, createOrg } = testIdentity();
(routes as unknown as OpenAPIHono).route("/", mediaRoutes({ media: () => files }));
const cookie = await signIn();
const W = (await createOrg(cookie, "Sweep")).workspace.id;

const mp4 = new Uint8Array(64);
mp4.set([0, 0, 0, 0x20, ...new TextEncoder().encode("ftypisom")]);
async function upload(kind: "source" | "clip") {
  const r = await routes.request(`/api/w/${W}/media?kind=${kind}`, { method: "POST", headers: { cookie }, body: mp4 });
  return ((await r.json()) as { media: { id: string } }).media.id;
}
const del = (id: string) => routes.request(`/api/w/${W}/media/${id}`, { method: "DELETE", headers: { cookie } });
const onDisk = (id: string) =>
  access(join(dir, W, id)).then(
    () => true,
    () => false,
  );
const row = async (id: string) => (await mediaRows(W)).find((r) => r.id === id)!;

test("a source 8 days old and a deleted clip lose their bytes; an old clip keeps them; a second run changes nothing", async () => {
  clock.at = new Date("2000-01-01T00:00:00Z");
  const source = await upload("source");
  const clip = await upload("clip");
  const gone = await upload("clip");
  expect((await del(gone)).status).toBe(204);

  clock.at = new Date("2000-01-07T23:00:00Z");
  await files.sweep();
  expect(await onDisk(source)).toBe(true);
  expect(await onDisk(gone)).toBe(false);

  clock.at = new Date("2000-01-09T00:00:00Z");
  await files.sweep();
  expect(await onDisk(source)).toBe(false);
  expect(await onDisk(clip)).toBe(true);
  expect(await row(source)).toMatchObject({ deletedAt: clock.at, bytesRemovedAt: clock.at });
  expect((await row(gone)).bytesRemovedAt).toEqual(new Date("2000-01-07T23:00:00Z"));
  expect(await row(clip)).toMatchObject({ deletedAt: null, bytesRemovedAt: null });

  clock.at = new Date("2000-02-01T00:00:00Z");
  await files.sweep();
  expect(await onDisk(clip)).toBe(true);
  expect((await row(source)).bytesRemovedAt).toEqual(new Date("2000-01-09T00:00:00Z"));
});

test("a file the store can't remove waits for the next run, and the rest carry on", async () => {
  clock.at = new Date("2000-03-01T00:00:00Z");
  const stuck = await upload("clip");
  const fine = await upload("clip");
  await del(stuck);
  await del(fine);
  failOn.add(`${W}/${stuck}`);
  const first = await files.sweep();
  expect(first.failed).toBeGreaterThanOrEqual(1);
  expect((await row(stuck)).bytesRemovedAt).toBeNull();
  expect(await onDisk(stuck)).toBe(true);
  expect(await onDisk(fine)).toBe(false);

  failOn.clear();
  await files.sweep();
  expect(await onDisk(stuck)).toBe(false);
  expect((await row(stuck)).bytesRemovedAt).toEqual(clock.at);
});
