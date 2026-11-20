// SPDX-License-Identifier: AGPL-3.0-only
// A Workspace's Search Console through the real plugin and its fake API: the properties it may
// choose, the one choice it reads from, paging, waiting out "busy", and each plain refusal.
import { expect, test } from "vitest";
import { seoWorld } from "./fixtures/world";

const w = seoWorld();
const row = (date: string, clicks: number, impressions: number) => ({ keys: [date], clicks, impressions, ctr: clicks / impressions, position: 4.2 });
const range = { startDate: "2026-10-01", endDate: "2026-10-28" };

async function connected(choose: string | null = "sc-domain:example.com") {
  const { W, userId } = await w.workspace();
  const credentialId = await w.connect(W, userId);
  if (choose) expect(await w.seo.choose(W, choose)).toEqual({ ok: true, siteUrl: choose });
  return { W, credentialId };
}
const analyticsCalls = () => w.sc.calls.filter((c) => c.path.endsWith("/searchAnalytics/query"));

test("without Search Console connected, every read says so", async () => {
  const { W } = await w.workspace();
  expect(await w.seo.state(W)).toEqual({
    connected: false,
    siteUrl: null,
    properties: null,
    refusal: { reason: "not_connected" },
    app: { source: "system", callbackUrl: "http://direx.test/api/connections/callback" },
  });
  expect(await w.seo.analytics(W, range, ["query"])).toEqual({ ok: false, reason: "not_connected" });
  expect(await w.seo.summary(W)).toEqual({ ok: false, reason: "not_connected" });
  expect(await w.seo.choose(W, "sc-domain:example.com")).toEqual({ ok: false, reason: "not_connected" });
});

test("once connected, the properties to choose from leave out unverified ones, and nothing is read before one is chosen", async () => {
  const { W } = await connected(null);
  expect(await w.seo.state(W)).toEqual({
    connected: true,
    siteUrl: null,
    properties: [
      { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
      { siteUrl: "https://full.example/", permissionLevel: "siteFullUser" },
      { siteUrl: "https://restricted.example/", permissionLevel: "siteRestrictedUser" },
    ],
    refusal: null,
  });
  const before = analyticsCalls().length;
  expect(await w.seo.summary(W)).toEqual({ ok: false, reason: "no_property" });
  expect(await w.seo.analytics(W, range, ["query"])).toEqual({ ok: false, reason: "no_property" });
  expect(analyticsCalls()).toHaveLength(before);
});

test("choosing saves the property on the connection, and choosing again replaces it", async () => {
  const { W, credentialId } = await connected();
  expect((await w.vault.find(W, credentialId))!.meta).toMatchObject({ siteUrl: "sc-domain:example.com" });
  expect(await w.seo.choose(W, "https://full.example/")).toEqual({ ok: true, siteUrl: "https://full.example/" });
  expect((await w.vault.find(W, credentialId))!.meta).toMatchObject({ siteUrl: "https://full.example/" });
  expect((await w.seo.state(W)).siteUrl).toBe("https://full.example/");
});

test("a property the account doesn't list, or lists as unverified, can't be chosen", async () => {
  const { W, credentialId } = await connected();
  expect(await w.seo.choose(W, "https://unverified.example/")).toEqual({ ok: false, reason: "not_listed" });
  expect(await w.seo.choose(W, "sc-domain:someone-else.com")).toEqual({ ok: false, reason: "not_listed" });
  expect((await w.vault.find(W, credentialId))!.meta).toMatchObject({ siteUrl: "sc-domain:example.com" });
});

test("analytics reads the chosen property only; a caller has no way to name another", async () => {
  const { W } = await connected();
  w.sc.rows.splice(0, w.sc.rows.length, row("2026-10-01", 3, 30));
  // @ts-expect-error there is no parameter for the property
  expect(await w.seo.analytics(W, range, ["date"], "https://full.example/")).toMatchObject({ ok: true, siteUrl: "sc-domain:example.com" });
  expect(await w.seo.analytics(W, { ...range, siteUrl: "https://full.example/" } as typeof range, ["date"])).toMatchObject({ ok: true, siteUrl: "sc-domain:example.com" });
  expect(analyticsCalls().slice(-2).map((c) => decodeURIComponent(c.path))).toEqual(Array(2).fill("/sites/sc-domain:example.com/searchAnalytics/query"));
});

test("analytics pages with startRow until a page comes back short", async () => {
  const { W } = await connected();
  const rows = Array.from({ length: 25_001 }, (_, i) => ({ keys: [`q${i}`], clicks: 1, impressions: 2, ctr: 0.5, position: 1 }));
  w.sc.rows.splice(0, w.sc.rows.length, ...rows);
  const before = analyticsCalls().length;
  const r = await w.seo.analytics(W, range, ["query"]);
  expect(r.ok && r.rows.length).toBe(25_001);
  expect(r.ok && r.rows.at(-1)!.keys).toEqual(["q25000"]);
  expect(analyticsCalls().slice(before).map((c) => (c.body as { startRow: number; rowLimit: number }).startRow)).toEqual([0, 25_000]);
  expect((analyticsCalls().at(-1)!.body as { rowLimit: number }).rowLimit).toBe(25_000);
});

test("busy is waited out for the time Search Console asks, then the read goes on", async () => {
  const { W } = await connected();
  w.sc.rows.splice(0, w.sc.rows.length, row("2026-10-01", 3, 30));
  w.waits.length = 0;
  w.sc.failNext("rate_limited");
  expect(await w.seo.analytics(W, range, ["date"])).toMatchObject({ ok: true, rows: [{ clicks: 3 }] });
  expect(w.waits).toEqual([60_000]);
});

test("busy past the waiting limit gives up with a plain refusal", async () => {
  const { W } = await connected();
  w.waits.length = 0;
  w.sc.failNext("rate_limited", 3);
  expect(await w.seo.analytics(W, range, ["date"])).toEqual({ ok: false, reason: "busy" });
  expect(w.waits).toEqual([60_000, 60_000]);
});

test("lost access to the property, and the API turned off, each refuse plainly; only self-host is told to turn it on", async () => {
  const { W } = await connected();
  w.sc.failNext("no_access");
  expect(await w.seo.summary(W)).toEqual({ ok: false, reason: "no_access" });
  w.sc.failNext("api_disabled");
  expect(await w.seo.summary(W)).toEqual({ ok: false, reason: "api_disabled", selfHost: true });
  w.deployment.selfHost = false;
  w.sc.failNext("api_disabled");
  expect(await w.seo.state(W)).toEqual({ connected: true, siteUrl: "sc-domain:example.com", properties: null, refusal: { reason: "api_disabled", selfHost: false } });
  w.deployment.selfHost = true;
});

test("a revoked token marks the connection as needing a reconnect, and nothing is asked of Google until then", async () => {
  const { W, credentialId } = await connected();
  w.sc.failNext("revoked");
  expect(await w.seo.analytics(W, range, ["query"])).toEqual({ ok: false, reason: "needs_reconnecting" });
  expect((await w.vault.find(W, credentialId))!.status).toBe("needs_reauth");
  const before = w.sc.calls.length;
  expect(await w.seo.summary(W)).toEqual({ ok: false, reason: "needs_reconnecting" });
  expect((await w.seo.state(W)).refusal).toEqual({ reason: "needs_reconnecting" });
  expect(w.sc.calls).toHaveLength(before);
});

test("the summary covers the 28 days ending 3 days before today, in UTC, and sums clicks and impressions", async () => {
  const { W } = await connected();
  w.clock.at = new Date("2026-11-06T00:30:00Z");
  w.sc.rows.splice(0, w.sc.rows.length, row("2026-10-07", 3, 100), row("2026-10-20", 5, 250), row("2026-11-03", 7, 400));
  expect(await w.seo.summary(W)).toEqual({
    ok: true,
    siteUrl: "sc-domain:example.com",
    startDate: "2026-10-07",
    endDate: "2026-11-03",
    clicks: 15,
    impressions: 750,
    position: expect.closeTo(4.2),
    daily: [{ date: "2026-10-07", position: 4.2 }, { date: "2026-10-20", position: 4.2 }, { date: "2026-11-03", position: 4.2 }],
    previous: null,
  });
  expect(analyticsCalls().at(-1)!.body).toMatchObject({ startDate: "2026-09-09", endDate: "2026-11-03", dimensions: ["date"] });
});

test("the summary's average rank weighs each day by how often the site was shown, now and in the 28 days before", async () => {
  const { W } = await connected();
  w.clock.at = new Date("2026-11-06T00:30:00Z");
  const day = (date: string, impressions: number, position: number) => ({ keys: [date], clicks: 1, impressions, ctr: 1 / impressions, position });
  w.sc.rows.splice(0, w.sc.rows.length, day("2026-09-10", 100, 12), day("2026-11-01", 300, 4), day("2026-10-08", 100, 10), day("2026-10-09", 0, 50));
  const s = await w.seo.summary(W);
  expect(s).toMatchObject({ position: 5.5, previous: { position: 12 } });
  // A day the site wasn't shown has no rank to draw, and the days come in order.
  expect("daily" in s && s.daily).toEqual([{ date: "2026-10-08", position: 10 }, { date: "2026-11-01", position: 4 }]);
});

test("the summary carries the 28 days before only when the data reaches back to their first week", async () => {
  const { W } = await connected();
  w.clock.at = new Date("2026-11-06T00:30:00Z");
  w.sc.rows.splice(0, w.sc.rows.length, row("2026-09-15", 2, 80), row("2026-10-06", 4, 120), row("2026-10-20", 5, 250));
  expect(await w.seo.summary(W)).toMatchObject({ clicks: 5, impressions: 250, previous: { startDate: "2026-09-09", endDate: "2026-10-06", clicks: 6, impressions: 200 } });
  // The property's data starts late in the earlier 28 days, so a comparison would be made up.
  w.sc.rows.splice(0, w.sc.rows.length, row("2026-09-16", 2, 80), row("2026-10-20", 5, 250));
  expect(await w.seo.summary(W)).toMatchObject({ clicks: 5, previous: null });
});

test("candidates read query and page pairs and page totals for the summary's 28 days, and page totals for the 28 before", async () => {
  const { W } = await connected();
  w.clock.at = new Date("2026-11-06T00:30:00Z");
  const pair = (query: string, impressions: number) => ({ keys: [query, "https://example.com/a"], clicks: 1, impressions, ctr: 1 / impressions, position: 10 });
  w.sc.rows.splice(0, w.sc.rows.length, pair("bank reconciliation", 50), pair("example login", 500));
  const before = analyticsCalls().length;
  const r = await w.seo.candidates(W, "Example");
  expect(r).toMatchObject({
    ok: true,
    siteUrl: "sc-domain:example.com",
    current: { startDate: "2026-10-07", endDate: "2026-11-03" },
    previous: { startDate: "2026-09-09", endDate: "2026-10-06" },
    nearPageOne: { total: 1, top: [{ query: "bank reconciliation", page: "https://example.com/a", impressions: 50, position: 10, positionBefore: 10 }] },
  });
  expect(analyticsCalls().slice(before).map((c) => c.body)).toMatchObject([
    { startDate: "2026-10-07", endDate: "2026-11-03", dimensions: ["query", "page"] },
    { startDate: "2026-10-07", endDate: "2026-11-03", dimensions: ["page"] },
    { startDate: "2026-09-09", endDate: "2026-10-06", dimensions: ["page"] },
    { startDate: "2026-09-09", endDate: "2026-10-06", dimensions: ["query", "page"] },
  ]);
});

test("candidates refuse as the summary does, and stop at the first refusal", async () => {
  const { W: none } = await w.workspace();
  expect(await w.seo.candidates(none, "Example")).toEqual({ ok: false, reason: "not_connected" });
  const { W } = await connected();
  const before = analyticsCalls().length;
  w.sc.failNext("no_access");
  expect(await w.seo.candidates(W, "Example")).toEqual({ ok: false, reason: "no_access" });
  expect(analyticsCalls().length - before).toBe(1);
});

test("clicks over a range add up each page and search, count a missing pair as none, and are null when it can't be read", async () => {
  const { W } = await connected();
  const pair = (query: string, page: string, clicks: number) => ({ keys: [query, page], clicks, impressions: clicks * 10 + 1, ctr: 0.1, position: 5 });
  w.sc.rows.splice(0, w.sc.rows.length, pair("month end close", "https://example.com/guide", 4), pair("Month End Close", "https://example.com/guide", 3), pair("month end close", "https://example.com/other", 9));
  expect(await w.seo.clicksOver(W, range, [{ page: "https://example.com/guide", query: " month end close " }, { page: "https://example.com/none", query: "x" }])).toEqual([7, 0]);
  expect(analyticsCalls().at(-1)?.body).toMatchObject({ startDate: "2026-10-01", endDate: "2026-10-28", dimensions: ["query", "page"] });
  w.sc.failNext("no_access");
  expect(await w.seo.clicksOver(W, range, [{ page: "https://example.com/guide", query: "month end close" }])).toBeNull();
});
