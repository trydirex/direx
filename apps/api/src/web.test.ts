// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { expect, test } from "vitest";
import { serveWeb, WEB_CSP } from "./web";

function app() {
  const dist = mkdtempSync(join(tmpdir(), "direx-web-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Direx</title>");
  writeFileSync(join(dist, "assets", "index-abc.js"), "console.log(1)");
  writeFileSync(join(dist, "favicon.svg"), "<svg/>");
  writeFileSync(join(tmpdir(), "direx-secret.txt"), "no");
  const a = new Hono();
  a.get("/api/me", (c) => c.json({ user: null }, 401));
  serveWeb(a, dist);
  return a;
}

test("an app path gets index.html with the CSP; a built asset is cached for good", async () => {
  const a = app();
  const page = await a.request("/w/abc/campaigns/c9?tab=drafts");
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("<title>Direx</title>");
  expect(page.headers.get("content-security-policy")).toBe(WEB_CSP);
  expect(page.headers.get("cache-control")).toBe("no-cache");
  const js = await a.request("/assets/index-abc.js");
  expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect((await a.request("/favicon.svg")).headers.get("cache-control")).toBe("no-cache");
});

test("API routes keep their own answers, and unknown API paths are 404, never the app", async () => {
  const a = app();
  expect((await a.request("/api/me")).status).toBe(401);
  expect((await a.request("/api/nope")).status).toBe(404);
  expect((await a.request("/health")).status).toBe(404);
});

test("a missing file is a 404, and no path reaches outside the build", async () => {
  const a = app();
  expect((await a.request("/logo.png")).status).toBe(404);
  expect((await a.request("/assets/%2e%2e/%2e%2e/direx-secret.txt")).status).toBe(404);
  expect((await a.request("/..%2fdirex-secret.txt")).status).toBe(404);
});

test("text is sent gzipped to a browser that accepts it; fonts and plain clients get the file as is", async () => {
  const a = app();
  const zipped = await a.request("/assets/index-abc.js", { headers: { "accept-encoding": "gzip" } });
  expect(zipped.headers.get("content-encoding")).toBe("gzip");
  expect(zipped.headers.get("vary")).toBe("accept-encoding");
  expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await zipped.arrayBuffer())))).toBe("console.log(1)");
  const plain = await a.request("/assets/index-abc.js");
  expect(plain.headers.get("content-encoding")).toBeNull();
  expect(await plain.text()).toBe("console.log(1)");
});

test("a browser that takes Brotli gets Brotli", async () => {
  const a = app();
  const res = await a.request("/assets/index-abc.js", { headers: { "accept-encoding": "gzip, deflate, br" } });
  expect(res.headers.get("content-encoding")).toBe("br");
  const { brotliDecompressSync } = await import("node:zlib");
  expect(brotliDecompressSync(new Uint8Array(await res.arrayBuffer())).toString()).toBe("console.log(1)");
});
