// SPDX-License-Identifier: AGPL-3.0-only
// The competitor list over HTTP with real sessions and roles, and a page reader that answers from a map.
import type { OpenAPIHono } from "@hono/zod-openapi";
import { expect, test } from "vitest";
import { TEST_SECRET, testIdentity } from "../identity/test-auth";
import { competitorRoutes, createCompetitors, createSnapshots, type ReadPage } from "./index";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;
type Read = Awaited<ReturnType<ReadPage>>;
const page = (url: string, text: string): Extract<Read, { ok: true }> => ({ ok: true, url, finalUrl: url, title: null, metaDescription: null, html: "", text, truncated: false, readAt: new Date() });
const pages = new Map<string, Read>();
const readPage: ReadPage = async (url) => pages.get(url) ?? { ok: false, reason: "failed", detail: "http_error 404" };

const clock = { at: new Date("2026-11-09T07:00:00Z") };
const snapshots = createSnapshots({ readPage, now: () => clock.at });
const { routes, signIn, createOrg, call, addMember } = testIdentity();
(routes as unknown as OpenAPIHono).route("/", competitorRoutes({ competitors: () => createCompetitors({ readPage }), snapshots: () => snapshots }));

const owner = await signIn();
const W = (await createOrg(owner, "Contoso")).workspace.id;
const url = (rest = "") => `/api/w/${W}/competitors${rest}`;
const send = (method: string, path: string, cookie: string, body?: unknown) => call(path, cookie, { method, ...(body !== undefined && { body }) });
type Saved = { competitor: { id: string; name: string; changelogUrl: string | null }; checks: { source: string; url: string; result: string; detail?: string }[] };
const add = async (body: unknown, cookie = owner) => {
  const r = await send("POST", url(), cookie, body);
  return { status: r.status, body: (await r.json()) as Saved & { error?: string } };
};
const list = async (cookie = owner) => ((await (await call(url(), cookie)).json()) as { competitors: { id: string; name: string }[] }).competitors;
const clear = async () => {
  for (const c of await list()) await send("DELETE", url(`/${c.id}`), owner);
};

pages.set("https://doublehq.com/pricing-plans/", page("https://doublehq.com/pricing-plans/", "Firm-wide add-ons Contact sales FAQ"));
pages.set("https://www.xenett.com/pricing", page("https://www.xenett.com/pricing", "Starter $49 per month"));
pages.set("https://roadmap.xenett.com/announcements", page("https://roadmap.xenett.com/announcements", "GL Rec, All Clients"));
pages.set("https://blocked.example/pricing", { ok: false, reason: "robots_disallowed" });

test("adding checks each URL given, and a pricing page with no price says so", async () => {
  await clear();
  const double = await add({ name: "Double", pricingUrl: "https://doublehq.com/pricing-plans/", changelogUrl: "" });
  expect(double.status).toBe(200);
  expect(double.body.competitor).toMatchObject({ name: "Double", changelogUrl: null });
  expect(double.body.checks).toEqual([{ source: "pricing", url: "https://doublehq.com/pricing-plans/", result: "no_prices" }]);

  const xenett = await add({ name: " Xenett ", pricingUrl: "https://www.xenett.com/pricing", changelogUrl: "https://roadmap.xenett.com/announcements" });
  expect(xenett.body.competitor.name).toBe("Xenett");
  expect(xenett.body.checks).toEqual([
    { source: "pricing", url: "https://www.xenett.com/pricing", result: "readable", prices: ["$49"] },
    { source: "changelog", url: "https://roadmap.xenett.com/announcements", result: "readable" },
  ]);
  expect((await list()).map((c) => c.name)).toEqual(["Double", "Xenett"]);
});

test("a blocked or broken URL is saved with its result", async () => {
  await clear();
  const r = await add({ name: "Blocked", pricingUrl: "https://blocked.example/pricing", landingUrl: "https://gone.example/" });
  expect(r.status).toBe(200);
  expect(r.body.checks).toEqual([
    { source: "pricing", url: "https://blocked.example/pricing", result: "robots_disallowed" },
    { source: "landing", url: "https://gone.example/", result: "failed", detail: "http_error 404" },
  ]);
  expect(await list()).toHaveLength(1);
});

test("field rules and a duplicate name are refused with their reason", async () => {
  await clear();
  expect((await add({ name: "Double", pricingUrl: null })).body.error).toBe("no_url");
  expect((await add({ name: "Double", pricingUrl: "ftp://doublehq.com" })).body.error).toBe("bad_url");
  expect((await add({ name: "  ", landingUrl: "https://a.example/" })).body.error).toBe("name_missing");
  expect((await add({ name: "Double", landingUrl: "https://a.example/", createdBy: "someone" })).status).toBe(400);
  await add({ name: "Double", landingUrl: "https://a.example/" });
  const dup = await add({ name: "DOUBLE", landingUrl: "https://b.example/" });
  expect(dup).toMatchObject({ status: 409, body: { error: "name_taken" } });
});

test("up to 5, and two adds at once at four make five, not six", async () => {
  await clear();
  for (const n of ["A", "B", "C", "D"]) await add({ name: n, landingUrl: "https://a.example/" });
  const both = await Promise.all([add({ name: "E", landingUrl: "https://a.example/" }), add({ name: "F", landingUrl: "https://a.example/" })]);
  expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(both.find((r) => r.status === 409)!.body.error).toBe("too_many");
  expect(await list()).toHaveLength(5);
});

test("an edit checks only the URLs that changed; Check again reads every one", async () => {
  await clear();
  const { competitor } = (await add({ name: "Xenett", pricingUrl: "https://www.xenett.com/pricing" })).body;
  const edited = await send("PATCH", url(`/${competitor.id}`), owner, { changelogUrl: "https://roadmap.xenett.com/announcements" });
  expect(edited.status).toBe(200);
  const body = (await edited.json()) as Saved;
  expect(body.checks.map((c) => c.source)).toEqual(["changelog"]);
  expect(body.competitor.changelogUrl).toBe("https://roadmap.xenett.com/announcements");

  const again = (await (await send("POST", url(`/${competitor.id}/check`), owner)).json()) as { checks: { source: string }[] };
  expect(again.checks.map((c) => c.source)).toEqual(["pricing", "changelog"]);

  // Our comparison page is kept, and never read by a check.
  const compared = (await (await send("PATCH", url(`/${competitor.id}`), owner, { comparisonUrl: "https://us.example/vs-xenett" })).json()) as Saved & { competitor: { comparisonUrl: string | null } };
  expect(compared.competitor.comparisonUrl).toBe("https://us.example/vs-xenett");
  expect(compared.checks).toEqual([]);
  expect((await send("PATCH", url(`/${competitor.id}`), owner, { comparisonUrl: "ftp://us.example/" })).status).toBe(400);

  const cleared = await send("PATCH", url(`/${competitor.id}`), owner, { pricingUrl: null, changelogUrl: "" });
  expect(cleared.status).toBe(400);
  expect(await cleared.json()).toEqual({ error: "no_url" });
});

test("an edit to a taken name is refused", async () => {
  await clear();
  await add({ name: "Double", landingUrl: "https://a.example/" });
  const { competitor } = (await add({ name: "Xenett", landingUrl: "https://b.example/" })).body;
  const r = await send("PATCH", url(`/${competitor.id}`), owner, { name: "double" });
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ error: "name_taken" });
});

test("removing deletes the row, and an unknown id is 404", async () => {
  await clear();
  const { competitor } = (await add({ name: "Booke AI", landingUrl: "https://booke.ai/" })).body;
  expect((await send("DELETE", url(`/${competitor.id}`), owner)).status).toBe(200);
  expect(await list()).toEqual([]);
  expect((await send("DELETE", url(`/${competitor.id}`), owner)).status).toBe(404);
  expect((await send("PATCH", url(`/${competitor.id}`), owner, { name: "x" })).status).toBe(404);
  expect((await send("POST", url(`/${competitor.id}/check`), owner)).status).toBe(404);
});

test("the list carries each page's last weekly read, and a viewer reads the last 4 weeks of Changes", async () => {
  await clear();
  const log = "https://roadmap.xenett.com/announcements";
  const { competitor } = (await add({ name: "Xenett", changelogUrl: log, landingUrl: "https://gone.example/" })).body;
  pages.set(log, { ...page(log, ""), html: "<p>GL Rec, All Clients</p>" });
  await snapshots.readWorkspace(W);
  clock.at = new Date("2026-11-16T07:00:00Z");
  pages.set(log, { ...page(log, ""), html: "<p>Late Close Flag</p><p>GL Rec, All Clients</p>" });
  await snapshots.readWorkspace(W);

  const listed = (await (await call(url(), owner)).json()) as { reads: { competitorId: string; source: string; url: string; readAt: string; failure: string | null }[] };
  expect(listed.reads.filter((r) => r.competitorId === competitor.id)).toEqual([
    { competitorId: competitor.id, source: "changelog", url: log, readAt: "2026-11-16T07:00:00.000Z", failure: null },
    { competitorId: competitor.id, source: "landing", url: "https://gone.example/", readAt: "2026-11-16T07:00:00.000Z", failure: "failed: http_error 404" },
  ]);
  const viewer = (await addMember(owner, W, "viewer")).cookie;
  const changes = await call(url(`/${competitor.id}/changes`), viewer);
  expect(changes.status).toBe(200);
  expect(await changes.json()).toMatchObject({ changes: [{ source: "changelog", detail: { added: ["Late Close Flag"] }, at: "2026-11-16T07:00:00.000Z", label: null, kind: null, sameAs: null, reason: null, itemId: null }] });
  expect((await call(url(`/${crypto.randomUUID()}/changes`), owner)).status).toBe(404);

  // Five weeks on, the Change has aged out of the list.
  clock.at = new Date("2026-12-21T07:00:00Z");
  expect(await (await call(url(`/${competitor.id}/changes`), owner)).json()).toEqual({ changes: [] });
});

test("a viewer can list but not change; another Workspace sees nothing", async () => {
  await clear();
  const { competitor } = (await add({ name: "Finlens", landingUrl: "https://www.finlens.app/" })).body;
  const viewer = (await addMember(owner, W, "viewer")).cookie;
  expect((await list(viewer)).map((c) => c.name)).toEqual(["Finlens"]);
  expect((await add({ name: "Other", landingUrl: "https://a.example/" }, viewer)).status).toBe(403);
  expect((await send("DELETE", url(`/${competitor.id}`), viewer)).status).toBe(403);
  expect((await send("POST", url(`/${competitor.id}/check`), viewer)).status).toBe(403);

  const stranger = await signIn();
  const W2 = (await createOrg(stranger, "Other")).workspace.id;
  expect(((await (await call(`/api/w/${W2}/competitors`, stranger)).json()) as { competitors: unknown[] }).competitors).toEqual([]);
  expect((await send("DELETE", `/api/w/${W2}/competitors/${competitor.id}`, stranger)).status).toBe(404);
});
