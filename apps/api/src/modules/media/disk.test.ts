// SPDX-License-Identifier: AGPL-3.0-only
// The disk store: bytes under the data directory, keyed by ids only.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { diskStore } from "./adapters/disk";
import { mediaKey } from "./adapters/store";

const dir = await mkdtemp(join(tmpdir(), "direx-media-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const store = diskStore(dir);
const W = crypto.randomUUID();
const stream = (bytes: Uint8Array<ArrayBuffer>) => new Response(bytes).body!;

test("put then read gives the same bytes; remove leaves nothing, and removing again is fine", async () => {
  const key = mediaKey(W, crypto.randomUUID());
  const bytes = crypto.getRandomValues(new Uint8Array(100_000));
  await store.put(key, stream(bytes));
  const read = await store.read(key);
  if (read.kind !== "file") throw new Error("disk serves files");
  expect(new Uint8Array(await read.file.arrayBuffer())).toEqual(bytes);
  await store.remove(key);
  await store.remove(key);
  expect(await readdir(join(dir, W))).toEqual([]);
});

test("a stream that fails leaves no file behind", async () => {
  const key = mediaKey(W, crypto.randomUUID());
  const failing = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(10));
      c.error(new Error("cut"));
    },
  });
  await expect(store.put(key, failing)).rejects.toThrow();
  expect(await readdir(join(dir, W))).toEqual([]);
});

test("a key is two ids and nothing else", () => {
  expect(() => mediaKey(W, "../../etc/passwd")).toThrow();
  expect(() => mediaKey("x/..", crypto.randomUUID())).toThrow();
  expect(() => store.remove(`${W}/../${crypto.randomUUID()}`)).toThrow();
});
