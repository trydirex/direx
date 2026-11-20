// SPDX-License-Identifier: AGPL-3.0-only
// Competitor proposals over HTTP with real sessions and roles: a scan of the Workspace's own site,
// dismissing, and adding a competitor closing its proposal. Pages and sitemaps come from maps.
import type { OpenAPIHono } from "@hono/zod-openapi";
import { expect, test } from "vitest";
import type { FetchHtml, FetchSitemap } from "../agents/index";
import { TEST_SECRET, testIdentity } from "../identity/test-auth";
import { createProposals } from "./application/proposals";
import { competitorRoutes, createCompetitors, createSnapshots, type ReadPage } from "./index";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;
const SITE = "https://www.equilityhq.com/";
type Html = Awaited<ReturnType<FetchHtml>>;
const html = (url: string, body: string): Html => ({ ok: true, url, status: 200, html: body, truncated: false });
const pages = new Map<string, Html>([
  ["https://www.equilityhq.com/robots.txt", html("https://www.equilityhq.com/robots.txt", "User-agent: *\nDisallow: /karbon-alternative\nSitemap: https://www.equilityhq.com/sitemap.xml")],
  ["https://www.equilityhq.com/botkeeper-alternative", html("https://www.equilityhq.com/botkeeper-alternative", `<a href="https://www.botkeeper.com/pricing">their pricing</a>`)],
  ["https://www.equilityhq.com/double-alternative", html("https://www.equilityhq.com/double-alternative", `<a href="/pricing">Our pricing</a>`)],
]);
const locs = ["double-alternative", "botkeeper-alternative", "karbon-alternative", "blog/evaluating-outsourced-accounting-firms-vs-in-house-accounting"].map((p) => SITE + p);
const fetched: string[] = [];
const fetchHtml: FetchHtml = async (_base, url) => {
  fetched.push(url);
  return pages.get(url) ?? { ok: false, url, reason: "http_error", status: 404 };
};
const fetchSitemap: FetchSitemap = async (_base, url) => (url === `${SITE}sitemap.xml` ? { ok: true, url, index: false, locs } : { ok: false, url, reason: "http_error" });

const readPage: ReadPage = async (url) => ({ ok: true, url, finalUrl: url, title: null, metaDescription: null, html: "", text: "", truncated: false, readAt: new Date() });
const { routes, signIn, createOrg, call, addMember } = testIdentity();
const sites = new Map<string, string>();
const proposals = createProposals({ site: async (w) => sites.get(w) ?? null, reads: { fetchHtml, fetchSitemap } });
const competitors = createCompetitors({ readPage });
(routes as unknown as OpenAPIHono).route("/", competitorRoutes({ competitors: () => competitors, snapshots: () => createSnapshots({ readPage }), proposals: () => proposals }));

const owner = await signIn();
const W = (await createOrg(owner, "Contoso")).workspace.id;
const url = (rest = "") => `/api/w/${W}/competitors${rest}`;
type Listed = { proposals: { id: string; name: string; site: string | null; comparisonUrl: string | null; source: string }[]; site: string | null; scannedAt: string | null };
const get = async (cookie = owner) => (await (await call(url("/proposals"), cookie)).json()) as Listed;
const scan = async (cookie = owner) => {
  const r = await call(url("/proposals/scan"), cookie, { method: "POST" });
  return { status: r.status, body: (await r.json()) as Listed & { error?: string } };
};
const names = (l: Listed) => l.proposals.map((p) => p.name);

test("with no Brand read of a website there is no site, nothing proposed and nothing to scan", async () => {
  expect(await get()).toEqual({ proposals: [], site: null, scannedAt: null });
  expect(await scan()).toEqual({ status: 409, body: { error: "no_site" } });
});

test("a scan proposes the competitors our comparison pages name, under robots.txt, once", async () => {
  sites.set(W, SITE);
  const first = await scan();
  expect(first.status).toBe(200);
  // Karbon's page is kept out by robots.txt, but its name is in the sitemap: proposed, never read.
  expect(first.body.proposals).toEqual([
    expect.objectContaining({ name: "Botkeeper", site: "https://www.botkeeper.com/", comparisonUrl: `${SITE}botkeeper-alternative`, source: "own_site" }),
    expect.objectContaining({ name: "Double", site: null, comparisonUrl: `${SITE}double-alternative` }),
    expect.objectContaining({ name: "Karbon", site: null }),
  ]);
  expect(fetched).not.toContain(`${SITE}karbon-alternative`);
  expect(first.body.site).toBe(SITE);
  expect(first.body.scannedAt).not.toBeNull();
  expect(names((await scan()).body)).toEqual(["Botkeeper", "Double", "Karbon"]);
});

test("a dismissed proposal is gone and never comes back", async () => {
  const karbon = (await get()).proposals.find((p) => p.name === "Karbon")!;
  expect((await call(url(`/proposals/${karbon.id}/dismiss`), owner, { method: "POST" })).status).toBe(200);
  expect((await call(url(`/proposals/${karbon.id}/dismiss`), owner, { method: "POST" })).status).toBe(404);
  expect(names((await scan()).body)).toEqual(["Botkeeper", "Double"]);
});

test("adding a competitor closes the proposal it answers, by the one used, its name or its site", async () => {
  const add = (body: object) => call(url(), owner, { method: "POST", body });
  // The proposal used, though the name was changed.
  const botkeeper = (await get()).proposals.find((p) => p.name === "Botkeeper")!;
  expect((await add({ name: "BK", landingUrl: "https://other.example/", proposalId: botkeeper.id })).status).toBe(200);
  expect(names(await get())).toEqual(["Double"]);
  // The same name, written another way, with no proposal sent.
  expect((await add({ name: "double", pricingUrl: "https://doublehq.com/pricing-plans/" })).status).toBe(200);
  expect(names(await get())).toEqual([]);
  // Names already on the list aren't proposed again.
  expect(names((await scan()).body)).toEqual([]);
});

test("a competitor already on the list by its site isn't proposed", async () => {
  const W2 = (await createOrg(owner, "Other")).workspace.id;
  sites.set(W2, SITE);
  expect((await call(`/api/w/${W2}/competitors`, owner, { method: "POST", body: { name: "Bot Keeper Inc", landingUrl: "https://botkeeper.com/" } })).status).toBe(200);
  const r = (await (await call(`/api/w/${W2}/competitors/proposals/scan`, owner, { method: "POST" })).json()) as Listed;
  expect(names(r)).toEqual(["Double", "Karbon"]);
});

test("a viewer reads proposals but can't scan or dismiss, and another Workspace's proposal isn't found", async () => {
  const viewer = (await addMember(owner, W, "viewer")).cookie;
  expect((await call(url("/proposals"), viewer)).status).toBe(200);
  expect((await scan(viewer)).status).toBe(403);
  expect((await call(url(`/proposals/${crypto.randomUUID()}/dismiss`), viewer, { method: "POST" })).status).toBe(403);
  expect((await call(url(`/proposals/${crypto.randomUUID()}/dismiss`), owner, { method: "POST" })).status).toBe(404);
});

test("a scan that runs past its limit says so and records nothing", async () => {
  const slow = createProposals({
    site: async () => SITE,
    reads: { fetchHtml: (_b, _u, signal) => new Promise((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason))), fetchSitemap },
    timeoutMs: 20,
  });
  expect(await slow.scan(W)).toEqual({ ok: false, reason: "timed_out" });
});
