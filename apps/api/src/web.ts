// SPDX-License-Identifier: AGPL-3.0-only
// The built web app, served by the API process from the same origin as /api, so the session cookie
// (SameSite=Lax) reaches both. In development Vite serves the app instead.
import { stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { Env, Hono } from "hono";
import { brotliCompressSync, constants } from "node:zlib";

// Base UI positions popups with inline styles, so styles allow 'unsafe-inline'. The newsletter
// preview is a srcdoc iframe, which inherits this policy: its images may come from anywhere on https.
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

// Text compresses to about a third; fonts and images are already compressed.
const COMPRESSIBLE = /^(text\/|application\/(javascript|json)|image\/svg)/;
type Encoding = "br" | "gzip";
const compressed = new Map<string, Promise<Blob>>();
/** Each file is compressed once per encoding per process: the build does not change while it runs. */
const compress = (path: string, encoding: Encoding) => {
  const key = `${encoding}:${path}`;
  if (!compressed.has(key)) {
    const squeeze = (b: Uint8Array<ArrayBuffer>) => (encoding === "br" ? brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }) : Bun.gzipSync(b));
    compressed.set(key, Bun.file(path).arrayBuffer().then((b) => new Blob([squeeze(new Uint8Array(b))])));
  }
  return compressed.get(key)!;
};
/** Brotli is about a fifth smaller than gzip on the app's JS; browsers that don't take it get gzip. */
const encodingFor = (accept: string): Encoding | null => (/\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : null);

/** Files from `dist`, and index.html for any other path the app owns. /api and /health are never touched. */
export function serveWeb<E extends Env>(app: Hono<E>, dist: string) {
  const root = resolve(dist);
  app.get("*", async (c, next) => {
    const url = c.req.path;
    if (url === "/health" || url === "/api" || url.startsWith("/api/")) return next();
    const wanted = resolve(root, `.${decodeURIComponent(url)}`);
    if (wanted !== root && !wanted.startsWith(root + sep)) return next();
    const asset = (await stat(wanted).catch(() => null))?.isFile() ? wanted : null;
    // A missing file is a 404, not an app page: /logo.png should not answer with index.html.
    if (!asset && extname(url)) return next();
    const path = asset ?? join(root, "index.html");
    const file = Bun.file(path);
    // Vite names built assets by content hash, so they never change; index.html always might.
    const cache = asset?.startsWith(join(root, "assets") + sep) ? "public, max-age=31536000, immutable" : "no-cache";
    const headers: Record<string, string> = { "content-type": file.type, "cache-control": cache, "content-security-policy": WEB_CSP, "x-content-type-options": "nosniff", "referrer-policy": "same-origin", vary: "accept-encoding" };
    const encoding = COMPRESSIBLE.test(file.type) ? encodingFor(c.req.header("accept-encoding") ?? "") : null;
    if (!encoding) return new Response(file, { headers });
    return new Response(await compress(path, encoding), { headers: { ...headers, "content-encoding": encoding } });
  });
}
