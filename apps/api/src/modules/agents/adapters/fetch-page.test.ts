// SPDX-License-Identifier: AGPL-3.0-only
// Blocked addresses come in pairs with a near miss that must stay allowed. No test here reaches
// the internet: names resolve through a stub, and pinning runs against a local TLS server.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createFetchHtml, createFetchImage, createFetchJson, createFetchPage, createFetchSitemap, htmlToText, isPublicAddress, linksIn, locsIn, pageAddress, PAGE_READER_AGENT, pinnedRequest, sameSite } from "./fetch-page";

const PUBLIC = "93.184.216.34";
const html = (body: string, init: ResponseInit = {}) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" }, ...init });
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

function page(routes: Record<string, () => Response>, dns: Record<string, string[]> = { "site.test": [PUBLIC], "www.site.test": [PUBLIC], "blog.site.test": [PUBLIC] }) {
  const connected: { url: string; address: string }[] = [];
  return {
    connected,
    fetchPage: createFetchPage({
      resolve: async (host) => (dns[host] ?? []).map((address) => ({ address })),
      request: async (url, address) => {
        connected.push({ url: url.href, address });
        return (routes[url.href] ?? (() => html("nope", { status: 404 })))();
      },
    }),
  };
}

test.each([
  ["10.0.0.1", "11.0.0.1"],
  ["172.16.0.1", "172.32.0.1"],
  ["172.31.255.255", "172.15.255.255"],
  ["192.168.1.1", "192.169.1.1"],
  ["127.0.0.1", "128.0.0.1"],
  ["169.254.169.254", "169.253.169.254"],
  ["100.64.0.1", "100.128.0.1"],
  ["0.0.0.0", "1.0.0.0"],
  ["224.0.0.1", "223.255.255.255"],
  ["::1", "2606:4700::1"],
  ["fe80::1", "2a00::1"],
  ["fd00::1", "2a01::1"],
  ["::ffff:127.0.0.1", "::ffff:8.8.8.8"],
  ["::ffff:7f00:1", "::ffff:808:808"],
  ["64:ff9b::7f00:1", "2a02::1"],
])("%s is refused and %s is allowed", (blocked, near) => {
  expect(isPublicAddress(blocked)).toBe(false);
  expect(isPublicAddress(near)).toBe(true);
});

test("a page's links are same-site, without query strings or fragments", () => {
  const html = `<a href="/about?ref=x#top">About</a> <A class="n" HREF='https://www.site.test/team'>Team</A> <a href=pricing>Pricing</a>
    <a href="https://evil.test/a">Off site</a> <a href="mailto:a@site.test">Mail</a> <a href="https://user:pw@site.test/b">Login</a> <a href="/about">Again</a>`;
  expect(linksIn(html, "https://site.test/home/", "https://site.test")).toEqual(["https://site.test/about", "https://www.site.test/team", "https://site.test/home/pricing"]);
});

test("a page keeps at most 100 links", () => {
  const html = Array.from({ length: 150 }, (_, i) => `<a href="/p${i}">x</a>`).join("");
  expect(linksIn(html, "https://site.test/", "https://site.test")).toHaveLength(100);
});

test("one spelling per address, and a bad one is refused", () => {
  expect(pageAddress("https://site.test", "https://site.test")).toBe("https://site.test/");
  expect(pageAddress("https://site.test", "/a?x=1#f")).toBe("https://site.test/a?x=1");
  expect(pageAddress("not a url", "also not")).toBeNull();
});

test("a fetched page returns its links; plain text has none", async () => {
  const { fetchPage } = page({
    "https://site.test/": () => html(`<a href="/about">About</a>`),
    "https://site.test/t": () => new Response(`<a href="/about">About</a>`, { headers: { "content-type": "text/plain" } }),
  });
  expect(await fetchPage("https://site.test/", "https://site.test/")).toMatchObject({ ok: true, links: ["https://site.test/about"] });
  expect(await fetchPage("https://site.test/", "https://site.test/t")).toMatchObject({ ok: true, links: [] });
});

test("something that isn't an address isn't public", () => {
  expect(isPublicAddress("localhost")).toBe(false);
  expect(isPublicAddress("")).toBe(false);
});

test("same site means the host, its www twin or a subdomain, and not a lookalike", () => {
  const base = new URL("https://site.test/");
  for (const ok of ["https://site.test/a", "https://www.site.test/", "https://blog.site.test/", "http://site.test/"]) expect(sameSite(base, new URL(ok))).toBe(true);
  for (const no of ["https://notsite.test/", "https://site.test.evil.example/", "https://other.test/"]) expect(sameSite(base, new URL(no))).toBe(false);
});

test("reads a page as text, connecting to the address it checked", async () => {
  const { fetchPage, connected } = page({ "https://site.test/": () => html("<title>Hi</title><script>steal()</script><p>We sell &amp; ship</p>") });
  const r = await fetchPage("https://site.test/", "https://site.test/");
  expect(r).toEqual({ ok: true, url: "https://site.test/", text: "Hi We sell & ship", truncated: false, links: [] });
  expect(connected).toEqual([{ url: "https://site.test/", address: PUBLIC }]);
});

test("a public name resolving to a private address never connects", async () => {
  const { fetchPage, connected } = page({}, { "site.test": ["10.0.0.5"] });
  expect(await fetchPage("https://site.test/", "https://site.test/")).toMatchObject({ ok: false, reason: "private_address" });
  expect(connected).toEqual([]);
});

test("one public and one private address is refused", async () => {
  const { fetchPage, connected } = page({}, { "site.test": [PUBLIC, "192.168.0.9"] });
  expect(await fetchPage("https://site.test/", "https://site.test/")).toMatchObject({ ok: false, reason: "private_address" });
  expect(connected).toEqual([]);
});

test("a name that changes its answer after the check is only ever connected to as checked", async () => {
  let asked = 0;
  const connected: string[] = [];
  const fetchPage = createFetchPage({
    resolve: async () => [{ address: asked++ === 0 ? PUBLIC : "127.0.0.1" }],
    request: async (_url, address) => {
      connected.push(address);
      return html("ok");
    },
  });
  expect((await fetchPage("https://site.test/", "https://site.test/")).ok).toBe(true);
  expect(asked).toBe(1);
  expect(connected).toEqual([PUBLIC]);
});

test("a redirect to a private address is refused, and one on the same public site is followed", async () => {
  const { fetchPage } = page(
    { "https://site.test/a": () => redirect("https://inner.site.test/"), "https://site.test/b": () => redirect("/c"), "https://site.test/c": () => html("end") },
    { "site.test": [PUBLIC], "inner.site.test": ["169.254.169.254"] },
  );
  expect(await fetchPage("https://site.test/", "https://site.test/a")).toMatchObject({ ok: false, reason: "private_address" });
  expect(await fetchPage("https://site.test/", "https://site.test/b")).toMatchObject({ ok: true, url: "https://site.test/c", text: "end" });
});

test("a redirect off the site is refused", async () => {
  const { fetchPage } = page({ "https://site.test/": () => redirect("https://other.test/") }, { "site.test": [PUBLIC], "other.test": [PUBLIC] });
  expect(await fetchPage("https://site.test/", "https://site.test/")).toMatchObject({ ok: false, reason: "other_site" });
});

test("five redirects are followed and a sixth is refused", async () => {
  const hops = (n: number, end: number): [string, () => Response][] =>
    Array.from({ length: n }, (_, i) => [`https://site.test/${i}`, () => (i === end ? html("end") : redirect(`/${i + 1}`))]);
  const five = page(Object.fromEntries(hops(6, 5)));
  expect((await five.fetchPage("https://site.test/", "https://site.test/0")).ok).toBe(true);
  const six = page(Object.fromEntries(hops(7, 6)));
  expect(await six.fetchPage("https://site.test/", "https://site.test/0")).toMatchObject({ ok: false, reason: "too_many_redirects" });
});

test.each(["file:///etc/passwd", "ftp://site.test/", "gopher://site.test/", "https://user:pw@site.test/"])("%s is refused", async (url) => {
  const { fetchPage, connected } = page({});
  const r = await fetchPage("https://site.test/", url);
  expect(r).toMatchObject({ ok: false, reason: "bad_address" });
  expect(connected).toEqual([]);
});

test.each(["http://127.0.0.1/", "http://2130706433/", "http://0x7f.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/"])("the address %s is refused however it is written", async (url) => {
  const { fetchPage, connected } = page({});
  const r = await fetchPage(url, url);
  expect(r).toMatchObject({ ok: false, reason: "private_address" });
  expect(connected).toEqual([]);
});

test("only text comes back, and a huge page is refused with its limit", async () => {
  const { fetchPage } = page({
    "https://site.test/pdf": () => new Response("%PDF", { headers: { "content-type": "application/pdf" } }),
    "https://site.test/none": () => new Response("x", { headers: { "content-type": "" } }),
    "https://site.test/plain": () => new Response("  just   words ", { headers: { "content-type": "text/plain" } }),
    "https://site.test/huge": () => html("x".repeat(2 * 1024 * 1024 + 1)),
    "https://site.test/limit": () => html("x".repeat(2 * 1024 * 1024)),
    "https://site.test/gone": () => html("no", { status: 500 }),
  });
  const read = (p: string) => fetchPage("https://site.test/", `https://site.test/${p}`);
  expect(await read("pdf")).toMatchObject({ reason: "not_text" });
  expect(await read("none")).toMatchObject({ reason: "not_text" });
  expect(await read("plain")).toMatchObject({ ok: true, text: "just words" });
  expect(await read("huge")).toMatchObject({ reason: "too_large" });
  expect(await read("limit")).toMatchObject({ ok: true, truncated: true });
  expect(await read("gone")).toMatchObject({ reason: "http_error" });
});

test("a name with no address, a dropped connection and a timeout are named failures", async () => {
  const none = page({}, {});
  expect(await none.fetchPage("https://site.test/", "https://site.test/")).toMatchObject({ reason: "no_address" });
  const dropped = createFetchPage({ resolve: async () => [{ address: PUBLIC }], request: async () => { throw new Error("ECONNRESET"); } });
  expect(await dropped("https://site.test/", "https://site.test/")).toMatchObject({ reason: "unreachable" });
  const aborted = new AbortController();
  aborted.abort();
  const slow = createFetchPage({ resolve: async () => [{ address: PUBLIC }], request: async (_u, _a, signal) => { signal.throwIfAborted(); return html("x"); } });
  expect(await slow("https://site.test/", "https://site.test/", aborted.signal)).toMatchObject({ reason: "timed_out" });
});

const xml = (body: string, type = "application/xml") => new Response(body, { headers: { "content-type": `${type}; charset=utf-8` } });

function sitemaps(routes: Record<string, () => Response>, dns: Record<string, string[]> = { "site.test": [PUBLIC] }) {
  return createFetchSitemap({
    resolve: async (host) => (dns[host] ?? []).map((address) => ({ address })),
    request: async (url) => (routes[url.href] ?? (() => html("nope", { status: 404 })))(),
  });
}

test("a sitemap gives its same-site addresses, without query strings, and isn't an index", async () => {
  const fetchSitemap = sitemaps({
    "https://site.test/sitemap.xml": () =>
      xml(`<?xml version="1.0"?><urlset><url><loc> https://site.test/about-us/ </loc></url><url><loc>https://site.test/p?a=1&amp;b=2</loc></url>
        <url><loc>https://evil.test/about</loc></url><url><loc>mailto:a@site.test</loc></url><url><loc>https://site.test/about-us/</loc></url></urlset>`),
  });
  expect(await fetchSitemap("https://site.test/", "/sitemap.xml")).toEqual({ ok: true, url: "https://site.test/sitemap.xml", index: false, locs: ["https://site.test/about-us/", "https://site.test/p"] });
});

test("a sitemap index is marked as one, and text/xml is read too", async () => {
  const fetchSitemap = sitemaps({
    "https://site.test/sitemap.xml": () => xml(`<sitemapindex><sitemap><loc>https://site.test/page-sitemap.xml</loc></sitemap></sitemapindex>`, "text/xml"),
  });
  expect(await fetchSitemap("https://site.test/", "/sitemap.xml")).toMatchObject({ ok: true, index: true, locs: ["https://site.test/page-sitemap.xml"] });
});

test("a sitemap gets the same refusals as a page", async () => {
  const fetchSitemap = sitemaps(
    {
      "https://site.test/html": () => html("<p>not a sitemap</p>"),
      "https://site.test/huge": () => xml("x".repeat(2 * 1024 * 1024 + 1)),
      "https://site.test/away": () => redirect("https://other.test/sitemap.xml"),
    },
    { "site.test": [PUBLIC], "other.test": [PUBLIC], "inner.test": ["10.0.0.1"] },
  );
  expect(await fetchSitemap("https://site.test/", "/html")).toMatchObject({ ok: false, reason: "not_text" });
  expect(await fetchSitemap("https://site.test/", "/huge")).toMatchObject({ ok: false, reason: "too_large" });
  expect(await fetchSitemap("https://site.test/", "/away")).toMatchObject({ ok: false, reason: "other_site" });
  expect(await fetchSitemap("https://inner.test/", "/sitemap.xml")).toMatchObject({ ok: false, reason: "private_address" });
});

test("a page fetch still refuses xml", async () => {
  const { fetchPage } = page({ "https://site.test/sitemap.xml": () => xml("<urlset/>") });
  expect(await fetchPage("https://site.test/", "/sitemap.xml")).toMatchObject({ ok: false, reason: "not_text" });
});

test("loc values with entities and relative addresses are resolved", () => {
  expect(locsIn("<loc>/a&amp;b</loc><LOC>https://www.site.test/x#f</LOC>", "https://site.test/")).toEqual(["https://site.test/a&b", "https://www.site.test/x"]);
});

test("html to text drops what a reader can't see", () => {
  expect(htmlToText("<style>a{}</style><!-- secret --><div>One</div><SCRIPT>x</SCRIPT> two&nbsp;&lt;3")).toBe("One two <3");
  // A page's quotes and dashes read as the page shows them, so a quote copied from it matches.
  expect(htmlToText("we&rsquo;ll send it &mdash; Booke&#x27;s &#39;AI&#39; &#8220;now&#8221; &unknown; &#99999999;")).toBe("we’ll send it — Booke's 'AI' “now” &unknown; &#99999999;");
});

// Against a real TLS server, so a runtime upgrade that stops honouring the pin or the name fails here.
const dir = mkdtempSync(join(tmpdir(), "direx-pin-"));
let server: ReturnType<typeof Bun.serve>;
let ca: string;
beforeAll(async () => {
  const proc = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=good.test", "-addext", "subjectAltName=DNS:good.test"], { stdout: "ignore", stderr: "ignore" });
  expect(await proc.exited).toBe(0);
  ca = await Bun.file(join(dir, "c.pem")).text();
  server = Bun.serve({ port: 0, tls: { cert: ca, key: await Bun.file(join(dir, "k.pem")).text() }, fetch: (req) => new Response(`host ${req.headers.get("host")}`) });
});
afterAll(() => server.stop(true));

test("a pinned request reaches the checked address and sends the real name", async () => {
  const res = await pinnedRequest(new URL(`https://good.test:${server.port}/`), "127.0.0.1", AbortSignal.timeout(5_000), { ca });
  expect(await res.text()).toBe(`host good.test:${server.port}`);
});

test("a pinned request refuses a certificate that doesn't cover the name", async () => {
  await expect(pinnedRequest(new URL(`https://wrong.test:${server.port}/`), "127.0.0.1", AbortSignal.timeout(5_000), { ca })).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
});

test("a pinned request refuses a certificate nobody vouches for", async () => {
  await expect(pinnedRequest(new URL(`https://good.test:${server.port}/`), "127.0.0.1", AbortSignal.timeout(5_000))).rejects.toBeDefined();
});

function htmlReader(routes: Record<string, () => Response>, dns: Record<string, string[]> = { "site.test": [PUBLIC], "other.test": [PUBLIC], "inner.site.test": ["169.254.169.254"], "inner.test": ["10.0.0.1"] }) {
  const connected: string[] = [];
  const fetchHtml = createFetchHtml({
    resolve: async (host) => (dns[host] ?? []).map((address) => ({ address })),
    request: async (url) => {
      connected.push(url.href);
      return (routes[url.href] ?? (() => html("nope", { status: 404 })))();
    },
  });
  return { fetchHtml, connected };
}

test("the HTML read keeps the page's markup, its final address and its status", async () => {
  const { fetchHtml } = htmlReader({ "https://site.test/a": () => redirect("/b"), "https://site.test/b": () => html(`<a href="mailto:jo@site.test">Jo</a>`) });
  expect(await fetchHtml("https://site.test/", "/a")).toEqual({ ok: true, url: "https://site.test/b", status: 200, html: `<a href="mailto:jo@site.test">Jo</a>`, truncated: false });
});

test("the HTML read is cut at 200 KB and says so", async () => {
  const { fetchHtml } = htmlReader({ "https://site.test/big": () => html("x".repeat(200 * 1024 + 1)), "https://site.test/fits": () => html("x".repeat(200 * 1024)) });
  const big = await fetchHtml("https://site.test/", "/big");
  expect(big).toMatchObject({ ok: true, truncated: true });
  expect(big.ok && big.html.length).toBe(200 * 1024);
  expect(await fetchHtml("https://site.test/", "/fits")).toMatchObject({ ok: true, truncated: false });
});

test("an uncapped HTML read keeps the whole body, up to the read limit", async () => {
  const body = "x".repeat(200 * 1024) + `<a href="mailto:jo@site.test">Jo</a>`;
  const fetchHtml = createFetchHtml({ maxChars: Infinity, resolve: async () => [{ address: PUBLIC }], request: async () => html(body) });
  expect(await fetchHtml("https://site.test/", "/")).toEqual({ ok: true, url: "https://site.test/", status: 200, html: body, truncated: false });
});

test("the HTML read gets every refusal a page read gets, before connecting where it must", async () => {
  const { fetchHtml, connected } = htmlReader({
    "https://site.test/private": () => redirect("https://inner.site.test/"),
    "https://site.test/away": () => redirect("https://other.test/"),
    "https://site.test/pdf": () => new Response("%PDF", { headers: { "content-type": "application/pdf" } }),
    "https://site.test/huge": () => html("x".repeat(2 * 1024 * 1024 + 1)),
  });
  const read = (base: string, url: string) => fetchHtml(base, url);
  expect(await read("https://inner.test/", "/")).toMatchObject({ ok: false, reason: "private_address" });
  expect(await read("https://site.test/", "/private")).toMatchObject({ ok: false, reason: "private_address" });
  expect(await read("https://site.test/", "/away")).toMatchObject({ ok: false, reason: "other_site" });
  expect(await read("https://site.test/", "/pdf")).toMatchObject({ ok: false, reason: "not_text" });
  expect(await read("https://site.test/", "/huge")).toMatchObject({ ok: false, reason: "too_large" });
  for (const url of ["file:///etc/passwd", "https://user:pw@site.test/", "http://127.0.0.1/", "http://[::ffff:127.0.0.1]/"]) {
    expect(await read(url.startsWith("http://") ? url : "https://site.test/", url)).toMatchObject({ ok: false });
  }
  expect(connected).not.toContain("https://inner.site.test/");
  expect(connected).not.toContain("https://other.test/");
});

test("the HTML read follows five redirects and refuses a sixth", async () => {
  const hops = (n: number, end: number): Record<string, () => Response> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`https://site.test/${i}`, () => (i === end ? html("end") : redirect(`/${i + 1}`))]));
  expect((await htmlReader(hops(6, 5)).fetchHtml("https://site.test/", "/0")).ok).toBe(true);
  expect(await htmlReader(hops(7, 6)).fetchHtml("https://site.test/", "/0")).toMatchObject({ ok: false, reason: "too_many_redirects" });
});

test("an HTTP error from the HTML read carries its status; a page read's doesn't", async () => {
  const { fetchHtml } = htmlReader({ "https://site.test/robots.txt": () => html("no", { status: 403 }) });
  expect(await fetchHtml("https://site.test/", "/robots.txt")).toEqual({ ok: false, url: "/robots.txt", reason: "http_error", status: 403 });
  expect(await fetchHtml("https://site.test/", "/missing")).toMatchObject({ ok: false, reason: "http_error", status: 404 });
  const { fetchPage } = page({ "https://site.test/x": () => html("no", { status: 403 }) });
  expect(await fetchPage("https://site.test/", "/x")).toEqual({ ok: false, url: "/x", reason: "http_error" });
});

test("robots.txt is asked for under the same name as every page", async () => {
  const agents: (string | null)[] = [];
  const plain = Bun.serve({ port: 0, fetch: (req) => (agents.push(req.headers.get("user-agent")), new Response("User-agent: *\nDisallow:", { headers: { "content-type": "text/plain" } })) });
  try {
    const fetchHtml = createFetchHtml({ resolve: async () => [{ address: PUBLIC }], request: (url, _address, signal) => pinnedRequest(url, "127.0.0.1", signal) });
    const fetchPage = createFetchPage({ resolve: async () => [{ address: PUBLIC }], request: (url, _address, signal) => pinnedRequest(url, "127.0.0.1", signal) });
    const base = `http://site.test:${plain.port}/`;
    expect(await fetchHtml(base, "/robots.txt")).toMatchObject({ ok: true, status: 200 });
    expect((await fetchPage(base, "/")).ok).toBe(true);
    expect(agents).toEqual([PAGE_READER_AGENT, PAGE_READER_AGENT]);
  } finally {
    await plain.stop(true);
  }
});

test("a preview image comes back as bytes only when it's PNG, JPEG, GIF or WebP, from a public address, within its limit", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const image = (type: string, body: BodyInit = png) => () => new Response(body, { headers: { "content-type": type } });
  const routes: Record<string, () => Response> = {
    "https://cdn.test/a.png": image("image/png"),
    "https://cdn.test/a.svg": image("image/svg+xml", "<svg onload='x()'/>"),
    "https://cdn.test/huge.jpg": image("image/jpeg", new Uint8Array(1024 * 1024 + 1)),
  };
  const fetchImage = createFetchImage({
    resolve: async (host) => (host === "cdn.test" ? [{ address: PUBLIC }] : host === "inside.test" ? [{ address: "10.0.0.5" }] : []),
    request: async (url) => (routes[url.href] ?? (() => html("nope", { status: 404 })))(),
  });
  const got = await fetchImage("https://cdn.test/a.png");
  expect(got).toEqual({ ok: true, type: "image/png", bytes: png });
  expect(await fetchImage("https://cdn.test/a.svg")).toEqual({ ok: false, reason: "not_text" });
  expect(await fetchImage("https://cdn.test/huge.jpg")).toEqual({ ok: false, reason: "too_large" });
  expect(await fetchImage("https://inside.test/a.png")).toEqual({ ok: false, reason: "private_address" });
});

function jsonReader(routes: Record<string, () => Response>, dns: Record<string, string[]> = { "client.test": [PUBLIC], "inner.test": ["10.0.0.1"] }) {
  return createFetchJson({
    resolve: async (host) => (dns[host] ?? []).map((address) => ({ address })),
    request: async (url) => (routes[url.href] ?? (() => new Response("nope", { status: 404 })))(),
  });
}
const json = (body: string, type = "application/json") => () => new Response(body, { headers: { "content-type": `${type}; charset=utf-8` } });

test("a JSON document comes from a public https address, with no redirect, in JSON, small", async () => {
  const doc = JSON.stringify({ client_id: "https://client.test/oauth.json", client_name: "Test client", redirect_uris: ["https://client.test/cb"] });
  const read = jsonReader({
    "https://client.test/oauth.json": json(doc),
    "https://client.test/moved.json": () => redirect("https://client.test/oauth.json"),
    "https://client.test/page": json("<html></html>", "text/html"),
    "https://client.test/big.json": json(JSON.stringify({ pad: "x".repeat(70 * 1024) })),
    "https://client.test/broken.json": json("{nope"),
    "https://inner.test/oauth.json": json(doc),
  });
  expect(await read("https://client.test/oauth.json")).toEqual({ ok: true, url: "https://client.test/oauth.json", value: JSON.parse(doc) });
  expect(await read("http://client.test/oauth.json")).toMatchObject({ ok: false, reason: "bad_address" });
  expect(await read("https://inner.test/oauth.json")).toMatchObject({ ok: false, reason: "private_address" });
  expect(await read("https://client.test/moved.json")).toMatchObject({ ok: false, reason: "too_many_redirects" });
  expect(await read("https://client.test/page")).toMatchObject({ ok: false, reason: "not_text" });
  expect(await read("https://client.test/big.json")).toMatchObject({ ok: false, reason: "too_large" });
  expect(await read("https://client.test/broken.json")).toMatchObject({ ok: false, reason: "not_json" });
  expect(await read("not a url")).toMatchObject({ ok: false, reason: "bad_address" });
});
