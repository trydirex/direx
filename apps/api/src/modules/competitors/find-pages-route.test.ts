// SPDX-License-Identifier: AGPL-3.0-only
// Find pages over HTTP with real sessions and roles, and pages and sitemaps answered from maps.
import type { OpenAPIHono } from "@hono/zod-openapi";
import { expect, test } from "vitest";
import type { FetchHtml, FetchSitemap } from "../agents/index";
import { TEST_SECRET, testIdentity } from "../identity/test-auth";
import { createFindPages } from "./application/find-pages";
import { competitorRoutes, createCompetitors, createSnapshots, type ReadPage } from "./index";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;
type Html = Awaited<ReturnType<FetchHtml>>;
const html = (url: string, body: string): Html => ({ ok: true, url, status: 200, html: body, truncated: false });
const pages = new Map<string, Html>();
const sitemaps = new Map<string, string[] | { index: string[] }>();
const fetched: string[] = [];
let gate: Promise<void> | null = null;

const fetchHtml: FetchHtml = async (_base, url) => {
  fetched.push(url);
  if (gate) await gate;
  return pages.get(url) ?? { ok: false, url, reason: "http_error", status: 404 };
};
const fetchSitemap: FetchSitemap = async (_base, url) => {
  fetched.push(url);
  const m = sitemaps.get(url);
  if (!m) return { ok: false, url, reason: "http_error" };
  return Array.isArray(m) ? { ok: true, url, index: false, locs: m } : { ok: true, url, index: true, locs: m.index };
};

const readPage: ReadPage = async () => ({ ok: false, reason: "failed" });
const { routes, signIn, createOrg, call, addMember } = testIdentity();
const competitors = createCompetitors({ readPage });
const snapshots = createSnapshots({ readPage });
(routes as unknown as OpenAPIHono).route("/", competitorRoutes({ competitors: () => competitors, snapshots: () => snapshots, findPages: createFindPages({ fetchHtml, fetchSitemap }) }));

const owner = await signIn();
const W = (await createOrg(owner, "Contoso")).workspace.id;
const find = async (landingUrl: string, cookie = owner) => {
  const r = await call(`/api/w/${W}/competitors/find-pages`, cookie, { method: "POST", body: { landingUrl } });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

pages.set("https://doublehq.com/robots.txt", html("https://doublehq.com/robots.txt", "User-agent: *\nDisallow: /app/\nSitemap: https://doublehq.com/sitemap_index.xml"));
pages.set("https://doublehq.com", html("https://doublehq.com/", `<a href="/pricing-plans/">Pricing</a><a href="https://doublehq.canny.io/changelog">Product Releases</a><a href="/app/pricing">App</a>`));
sitemaps.set("https://doublehq.com/sitemap_index.xml", { index: ["https://doublehq.com/a.xml", "https://doublehq.com/b.xml", "https://doublehq.com/c.xml", "https://doublehq.com/d.xml", "https://doublehq.com/e.xml"] });
sitemaps.set("https://doublehq.com/a.xml", ["https://doublehq.com/plans"]);

test("the homepage and sitemap give the pricing and changelog pages, each with where it was found", async () => {
  fetched.length = 0;
  const r = await find("https://doublehq.com");
  expect(r.status).toBe(200);
  expect(r.body).toEqual({
    ok: true,
    pricing: { url: "https://doublehq.com/plans", via: "sitemap", text: "" },
    changelog: { url: "https://doublehq.canny.io/changelog", via: "homepage", text: "Product Releases" },
    alsoPricing: ["https://doublehq.com/pricing-plans/"],
  });
  // The robots.txt sitemap, then at most 3 of its 5 children: 4 sitemap files in all.
  expect(fetched.filter((u) => u.endsWith(".xml"))).toEqual(["https://doublehq.com/sitemap_index.xml", "https://doublehq.com/a.xml", "https://doublehq.com/b.xml", "https://doublehq.com/c.xml"]);
  // /app/pricing is kept out by robots.txt, so it is not proposed, and the hosted changelog is never read.
  expect(JSON.stringify(r.body)).not.toContain("/app/pricing");
  expect(fetched).not.toContain("https://doublehq.canny.io/changelog");
});

test("with no changelog found, the roadmap page the homepage links is read once, under its own robots.txt", async () => {
  pages.set("https://www.xenett.com/robots.txt", html("https://www.xenett.com/robots.txt", "User-agent: *\nAllow: /"));
  pages.set("https://www.xenett.com", html("https://www.xenett.com/", `<a href="/pricing">Pricing</a><a href="https://roadmap.xenett.com/roadmap">Roadmap</a>`));
  pages.set("https://roadmap.xenett.com/robots.txt", html("https://roadmap.xenett.com/robots.txt", "User-agent: *\nDisallow: /graphql"));
  pages.set("https://roadmap.xenett.com/roadmap", html("https://roadmap.xenett.com/roadmap", `<a href="/announcements">Announcements</a>`));
  fetched.length = 0;
  const r = await find("https://www.xenett.com");
  expect(r.body).toMatchObject({ ok: true, pricing: { url: "https://www.xenett.com/pricing" }, changelog: { url: "https://roadmap.xenett.com/announcements", via: "roadmap" } });
  // No Sitemap line, so the usual address is tried.
  expect(fetched).toContain("https://www.xenett.com/sitemap.xml");
  expect(fetched.filter((u) => u === "https://roadmap.xenett.com/roadmap")).toHaveLength(1);
});

test("a roadmap page its robots.txt keeps us out of is not read", async () => {
  pages.set("https://roadmap.xenett.com/robots.txt", html("https://roadmap.xenett.com/robots.txt", "User-agent: *\nDisallow: /"));
  fetched.length = 0;
  const r = await find("https://www.xenett.com");
  expect(r.body).toMatchObject({ ok: true, changelog: null });
  expect(fetched).not.toContain("https://roadmap.xenett.com/roadmap");
});

test("a homepage that can't be read says why, and nothing is proposed", async () => {
  pages.set("https://blocked.example/robots.txt", html("https://blocked.example/robots.txt", "User-agent: *\nDisallow: /"));
  expect((await find("https://blocked.example")).body).toEqual({ ok: false, reason: "robots_disallowed" });
  expect((await find("https://gone.example")).body).toEqual({ ok: false, reason: "unreadable", detail: "http_error 404" });
  pages.set("https://keeper.app", { ok: false, url: "https://keeper.app", reason: "other_site" });
  expect((await find("https://keeper.app")).body).toEqual({ ok: false, reason: "other_site" });
});

test("one Find pages at a time per Workspace", async () => {
  let release!: () => void;
  gate = new Promise((r) => (release = r));
  const first = find("https://doublehq.com");
  const second = await find("https://doublehq.com");
  expect(second).toEqual({ status: 409, body: { error: "busy" } });
  release();
  gate = null;
  expect((await first).status).toBe(200);
});

test("a read that runs past the limit stops and says so", async () => {
  const slow = createFindPages({ fetchHtml: (_b, _u, signal) => new Promise((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason))), fetchSitemap, timeoutMs: 20 });
  expect(await slow(W, "https://doublehq.com")).toEqual({ ok: false, reason: "unreadable", detail: "timed_out" });
});

test("only people who may change competitors can look, and the address must be a web address", async () => {
  const viewer = (await addMember(owner, W, "viewer")).cookie;
  expect((await find("https://doublehq.com", viewer)).status).toBe(403);
  expect((await find("ftp://doublehq.com")).status).toBe(400);
  // Someone outside the Workspace isn't told it exists.
  const outsider = await signIn();
  expect((await find("https://doublehq.com", outsider)).status).toBe(404);
});
