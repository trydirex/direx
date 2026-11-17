// SPDX-License-Identifier: AGPL-3.0-only
// Reading one page for SEO, against a local server standing in for a public site.
import { afterAll, expect, test } from "vitest";
import { createFetchHtml, PAGE_READER_AGENT } from "../agents/index";
import { createPageReader } from "./application/read-page";

const NOW = new Date("2026-11-06T10:00:00Z");
const HEAD = `<head><meta charset="utf-8"><title>Plant &amp; Co</title><meta content="Pots, soil &amp; seeds." name="description"></head>`;
const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
const ROUTES: Record<string, () => Response> = {
  "/robots.txt": () => new Response(`User-agent: ${PAGE_READER_AGENT}\nDisallow: /private`, { headers: { "content-type": "text/plain" } }),
  "/": () => html(`<html>${HEAD}<body><h1>Plants</h1><script>x()</script><p>We grow them.</p></body></html>`),
  "/private": () => html("<title>secret</title>"),
  "/big": () => html(`<html>${HEAD}<body>${"é".repeat(150 * 1024)}</body></html>`),
  "/huge": () => html("x".repeat(2 * 1024 * 1024 + 1)),
  "/pdf": () => new Response("%PDF", { headers: { "content-type": "application/pdf" } }),
  "/broken": () => new Response("no", { status: 500 }),
};

const seen: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch: (req) => {
    const path = new URL(req.url).pathname;
    seen.push(path);
    return (ROUTES[path] ?? (() => new Response("missing", { status: 404 })))();
  },
});
afterAll(() => server.stop(true));

// The name resolves to a public address, and the request goes to the local server instead.
const fetchHtml = createFetchHtml({
  maxChars: Infinity,
  resolve: async () => [{ address: "93.184.216.34" }],
  request: (url, _address, signal) => fetch(`http://127.0.0.1:${server.port}${url.pathname}${url.search}`, { signal, redirect: "manual", headers: { "User-Agent": PAGE_READER_AGENT } }),
});
const readPage = createPageReader({ fetchHtml, now: () => NOW });
const at = (path: string) => `http://site.test:${server.port}${path}`;

test("an allowed page gives its title, meta description and text", async () => {
  const got = await readPage(at("/"));
  expect(got).toMatchObject({ ok: true, url: at("/"), finalUrl: at("/"), title: "Plant & Co", metaDescription: "Pots, soil & seeds.", truncated: false, readAt: NOW });
  expect(got.ok && got.text).toBe("Plant & Co Plants We grow them.");
  expect(got.ok && got.html).toContain("<h1>Plants</h1>");
});

test("a page robots.txt disallows is refused without being fetched", async () => {
  seen.length = 0;
  expect(await readPage(at("/private"))).toEqual({ ok: false, reason: "robots_disallowed" });
  expect(seen).toEqual(["/robots.txt"]);
});

test("a page over the stored size is cut; one over the read limit is refused", async () => {
  const big = await readPage(at("/big"));
  expect(big).toMatchObject({ ok: true, title: "Plant & Co", truncated: true });
  expect(big.ok && new TextEncoder().encode(big.html).length).toBeLessThanOrEqual(200 * 1024);
  expect(big.ok && new TextEncoder().encode(big.text).length).toBeLessThanOrEqual(200 * 1024);
  expect(big.ok && big.html.endsWith("é")).toBe(true);
  expect(await readPage(at("/huge"))).toEqual({ ok: false, reason: "too_big" });
});

test("a page that won't load is refused with a reason", async () => {
  expect(await readPage(at("/broken"))).toEqual({ ok: false, reason: "failed", detail: "http_error 500" });
  expect(await readPage(at("/pdf"))).toEqual({ ok: false, reason: "not_html" });
  expect(await readPage("not a url")).toEqual({ ok: false, reason: "failed", detail: "bad_address" });
});

test("control characters in a page, a null among them, become spaces", async () => {
  const { htmlToText } = await import("../agents/index");
  expect(htmlToText("<p>Free\u0000software\u0007 for\u001fall</p>")).toBe("Free software for all");
});
