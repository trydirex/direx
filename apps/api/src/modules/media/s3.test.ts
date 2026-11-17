// SPDX-License-Identifier: AGPL-3.0-only
// The object storage store, against a local fake that speaks enough S3 for put, multipart, get and delete.
import type { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, expect, test } from "vitest";
import { parseS3Url, s3Store } from "./adapters/s3";
import { mediaKey } from "./adapters/store";
import { TEST_SECRET, testIdentity } from "./fixtures/support";
import { createMedia, mediaRoutes } from "./index";

const objects = new Map<string, Uint8Array<ArrayBuffer>>();
const uploads = new Map<string, Map<number, Uint8Array<ArrayBuffer>>>();
const xml = (body: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { headers: { "content-type": "application/xml" } });
const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const key = decodeURIComponent(url.pathname);
    const q = url.searchParams;
    if (req.method === "POST" && q.has("uploads")) {
      const id = crypto.randomUUID();
      uploads.set(id, new Map());
      return xml(`<InitiateMultipartUploadResult><Bucket>b</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (req.method === "PUT" && q.has("uploadId")) {
      uploads.get(q.get("uploadId")!)!.set(Number(q.get("partNumber")), new Uint8Array(await req.arrayBuffer()));
      return new Response(null, { headers: { etag: `"${q.get("partNumber")}"` } });
    }
    if (req.method === "POST" && q.has("uploadId")) {
      const parts = [...uploads.get(q.get("uploadId")!)!.entries()].sort(([a], [b]) => a - b).map(([, p]) => p);
      objects.set(key, new Uint8Array(await new Blob(parts).arrayBuffer()));
      return xml(`<CompleteMultipartUploadResult><Key>${key}</Key><ETag>"x"</ETag></CompleteMultipartUploadResult>`);
    }
    if (req.method === "DELETE" && q.has("uploadId")) return new Response(null, { status: 204 });
    if (req.method === "PUT") {
      objects.set(key, new Uint8Array(await req.arrayBuffer()));
      return new Response(null, { headers: { etag: '"x"' } });
    }
    if (req.method === "GET") return objects.has(key) ? new Response(objects.get(key)!) : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    if (req.method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 400 });
  },
});
afterAll(() => fake.stop(true));

const store = s3Store(parseS3Url(`http://AKIDTEST:sekret@localhost:${fake.port}/clips?region=auto`));
const W = crypto.randomUUID();
const bytesOf = (size: number) => {
  const b = new Uint8Array(size);
  b.set(crypto.getRandomValues(new Uint8Array(65536)));
  for (let at = 65536; at < size; at *= 2) b.copyWithin(at, 0, Math.min(at, size - at));
  return b;
};
// Hashes, not element by element: comparing 12 MiB that way takes longer than the test may run.
const sha = (b: Uint8Array | ArrayBuffer) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

test("a small file and a multipart one land in the bucket; a read is a link that serves them; remove deletes", async () => {
  for (const size of [100_000, 12 * 1024 * 1024]) {
    const key = mediaKey(W, crypto.randomUUID());
    const full = bytesOf(size);
    await store.put(key, new Response(full).body!);
    expect(sha(objects.get(`/clips/${key}`)!)).toBe(sha(full));
    const read = await store.read(key);
    if (read.kind !== "url") throw new Error("object storage serves links");
    expect(read.url).toContain("X-Amz-Expires=900");
    expect(sha(await (await fetch(read.url)).arrayBuffer())).toBe(sha(full));
    await store.remove(key);
    await store.remove(key);
    expect(objects.has(`/clips/${key}`)).toBe(false);
  }
});

test("a stream that fails leaves no object behind", async () => {
  const key = mediaKey(W, crypto.randomUUID());
  const failing = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(10));
      c.error(new Error("cut"));
    },
  });
  await expect(store.put(key, failing)).rejects.toThrow("cut");
  expect(objects.has(`/clips/${key}`)).toBe(false);
});

test("a malformed value is refused with the expected form, never the value itself", () => {
  for (const bad of ["s3://AK:SK@host/b", "https://host/bucket", "https://AK:SK@host/", "https://AK:SK@host/a/b", "not a url sekret"]) {
    let message = "";
    try {
      parseS3Url(bad);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("https://<access key>:<secret>@<host>/<bucket>?region=<region>");
    expect(message).not.toContain("SK");
    expect(message).not.toContain("sekret");
  }
  expect(parseS3Url("https://AK:S%2FK@r2.example.com/media?region=weur")).toEqual({
    endpoint: "https://r2.example.com",
    bucket: "media",
    region: "weur",
    accessKeyId: "AK",
    secretAccessKey: "S/K",
  });
});

test("on object storage an upload lands in the bucket and a read redirects to a link", async () => {
  process.env.DIREX_AUTH_SECRET = TEST_SECRET;
  const files = createMedia({ store: () => store, now: () => new Date() });
  const { routes, signIn, createOrg } = testIdentity();
  (routes as unknown as OpenAPIHono).route("/", mediaRoutes({ media: () => files }));
  const cookie = await signIn();
  const ws = (await createOrg(cookie, "Bucket")).workspace.id;
  const mp4 = bytesOf(200_000);
  mp4.set([0, 0, 0, 0x20, ...new TextEncoder().encode("ftypisom")]);
  const up = await routes.request(`/api/w/${ws}/media?kind=clip`, { method: "POST", headers: { cookie }, body: mp4 });
  expect(up.status).toBe(201);
  const { media } = (await up.json()) as { media: { id: string } };
  expect(sha(objects.get(`/clips/${ws}/${media.id}`)!)).toBe(sha(mp4));
  const read = await routes.request(`/api/w/${ws}/media/${media.id}`, { headers: { cookie } });
  expect(read.status).toBe(302);
  const link = read.headers.get("location")!;
  expect(link).toContain(`/clips/${ws}/${media.id}`);
  expect(sha(await (await fetch(link)).arrayBuffer())).toBe(sha(mp4));
});
