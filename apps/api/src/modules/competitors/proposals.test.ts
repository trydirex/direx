// SPDX-License-Identifier: AGPL-3.0-only
// Competitor proposals over HTTP with real sessions and roles: a scan of the Workspace's own site,
// dismissing, and adding a competitor closing its proposal. Pages and sitemaps come from maps.
import type { OpenAPIHono } from "@hono/zod-openapi";
import { expect, test } from "vitest";
import { ownerClient } from "../../../../../test/db";
import type { FetchHtml, FetchSitemap } from "../agents/index";
import type { Discovery } from "../extensions/index";
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
// No search installed until a test installs one.
let discovery: Discovery | undefined;
const proposals = createProposals({ site: async (w) => sites.get(w) ?? null, reads: { fetchHtml, fetchSitemap }, discovery: () => discovery });
const competitors = createCompetitors({ readPage });
(routes as unknown as OpenAPIHono).route("/", competitorRoutes({ competitors: () => competitors, snapshots: () => createSnapshots({ readPage }), proposals: () => proposals }));

const owner = await signIn();
const W = (await createOrg(owner, "Contoso")).workspace.id;
const url = (rest = "") => `/api/w/${W}/competitors${rest}`;
type Listed = { proposals: { id: string; name: string; site: string | null; comparisonUrl: string | null; source: string }[]; site: string | null; scannedAt: string | null; searchAvailable?: boolean };
const get = async (cookie = owner) => (await (await call(url("/proposals"), cookie)).json()) as Listed;
const scan = async (cookie = owner) => {
  const r = await call(url("/proposals/scan"), cookie, { method: "POST" });
  return { status: r.status, body: (await r.json()) as Listed & { error?: string } };
};
const names = (l: Listed) => l.proposals.map((p) => p.name);

test("with no Brand read of a website there is no site, nothing proposed and nothing to scan", async () => {
  expect(await get()).toEqual({ proposals: [], site: null, scannedAt: null, searchAvailable: false });
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

const post = (path: string, body: object, cookie = owner, w = W) => call(`/api/w/${w}/competitors/proposals/${path}`, cookie, { method: "POST", body });

test("with no search installed, the panel says so and an estimate is refused", async () => {
  discovery = undefined;
  expect((await get()).searchAvailable).toBe(false);
  const r = await post("estimate", { terms: ["bank reconciliation software"] });
  expect([r.status, await r.json()]).toEqual([409, { error: "not_available" }]);
});

test("a paid search shows its cost first, needs that much confirmed, and proposes what it finds once", async () => {
  const searched: string[][] = [];
  let results = [
    { domain: "doublehq.com", name: "Double", source: "s" },
    { domain: "xenett.com", name: "Xenett", source: "s" },
    { domain: "www.equilityhq.com", name: "Equility", source: "s" },
    { domain: "booke.ai", name: "", source: "s" },
  ];
  discovery = { estimate: async () => ({ usd: 0.12 }), search: async (_w, terms) => (searched.push(terms), results) };
  const W3 = (await createOrg(owner, "Searching")).workspace.id;
  sites.set(W3, SITE);
  expect((await (await call(`/api/w/${W3}/competitors/proposals`, owner)).json()).searchAvailable).toBe(true);
  const estimate = await post("estimate", { terms: ["bank reconciliation software"] }, owner, W3);
  expect([estimate.status, await estimate.json()]).toEqual([200, { usd: 0.12 }]);

  const low = await post("search", { terms: ["bank reconciliation software"], confirmedUsd: 0.1 }, owner, W3);
  expect([low.status, await low.json()]).toEqual([400, { error: "below_estimate" }]);
  expect(searched).toEqual([]);

  const found = (await (await post("search", { terms: ["bank reconciliation software"], confirmedUsd: 0.12 }, owner, W3)).json()) as Listed & { proposals: { terms: string[] | null }[] };
  // The Workspace's own site is never proposed; a company with no name goes by its domain.
  expect(found.proposals.map((p) => [p.name, p.site, p.source])).toEqual([
    ["booke.ai", "https://booke.ai/", "search"],
    ["Double", "https://doublehq.com/", "search"],
    ["Xenett", "https://xenett.com/", "search"],
  ]);
  expect(found.proposals[0]!.terms).toEqual(["bank reconciliation software"]);

  // A search that finds nothing new is still recorded, with what was confirmed and by whom.
  results = [{ domain: "doublehq.com", name: "Double", source: "s" }];
  expect(names((await (await post("search", { terms: ["bookkeeping automation"], confirmedUsd: 0.5 }, owner, W3)).json()) as Listed)).toEqual(["booke.ai", "Double", "Xenett"]);
  const db = await ownerClient();
  const { rows } = await db.query("select terms, confirmed_micros from competitor_finds where workspace_id = $1 and kind = 'search' order by at", [W3]);
  await db.end();
  expect(rows).toEqual([
    { terms: ["bank reconciliation software"], confirmed_micros: "120000" },
    { terms: ["bookkeeping automation"], confirmed_micros: "500000" },
  ]);
});

test("search terms holding an email or a web address are refused, and only an Owner or Admin may search", async () => {
  discovery = { estimate: async () => ({ usd: 0.12 }), search: async () => [] };
  for (const term of ["mail sam@contoso.example", "see contoso.example/pricing"]) {
    const r = await post("estimate", { terms: [term] });
    expect([r.status, await r.json()]).toEqual([400, { error: "person_data" }]);
  }
  expect((await post("estimate", { terms: ["a", "b", "c", "d"] })).status).toBe(400);
  const viewer = (await addMember(owner, W, "viewer")).cookie;
  expect((await post("search", { terms: ["bank rec"], confirmedUsd: 1 }, viewer)).status).toBe(403);
});
