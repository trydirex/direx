// SPDX-License-Identifier: AGPL-3.0-only
// The SEO page's Search Console routes: state, choosing a property and the 28-day summary.
import { expect, test } from "vitest";
import { seoWorld } from "./fixtures/world";

const w = seoWorld();
const { W, cookie, userId } = await w.workspace();
const base = `/api/w/${W}/seo/search-console`;
const choose = (siteUrl: unknown) => w.call(`${base}/property`, cookie, { method: "POST", body: { siteUrl } });

test("before connecting, the state says so and the summary is refused", async () => {
  expect(await (await w.call(base, cookie)).json()).toEqual({ connected: false, siteUrl: null, properties: null, refusal: { reason: "not_connected" } });
  const r = await w.call(`${base}/summary`, cookie);
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ error: "not_connected" });
  const c = await w.call(`/api/w/${W}/seo/candidates`, cookie);
  expect(c.status).toBe(409);
  expect(await c.json()).toEqual({ error: "not_connected" });
});

test("a person picks a listed property and sees its summary; an unlisted one or a bad body is refused", async () => {
  await w.connect(W, userId);
  w.clock.at = new Date("2026-11-06T12:00:00Z");
  w.sc.rows.splice(0, w.sc.rows.length, { keys: ["2026-10-10"], clicks: 4, impressions: 40, ctr: 0.1, position: 3 });
  expect(((await (await w.call(base, cookie)).json()) as { properties: unknown[] }).properties).toHaveLength(3);
  const refused = await choose("https://unverified.example/");
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: "not_listed" });
  expect((await choose(42)).status).toBe(400);
  const chosen = await choose("sc-domain:example.com");
  expect(chosen.status).toBe(200);
  expect(await chosen.json()).toEqual({ siteUrl: "sc-domain:example.com" });
  expect(await (await w.call(`${base}/summary`, cookie)).json()).toEqual({ siteUrl: "sc-domain:example.com", startDate: "2026-10-07", endDate: "2026-11-03", clicks: 4, impressions: 40, position: expect.any(Number), daily: expect.any(Array), previous: null });
});

test("candidates come back for the chosen property, with both windows", async () => {
  w.sc.rows.splice(0, w.sc.rows.length, { keys: ["bank reconciliation", "https://example.com/a"], clicks: 1, impressions: 30, ctr: 0.03, position: 12 });
  const r = await w.call(`/api/w/${W}/seo/candidates`, cookie);
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({
    siteUrl: "sc-domain:example.com",
    current: { startDate: "2026-10-07", endDate: "2026-11-03" },
    previous: { startDate: "2026-09-09", endDate: "2026-10-06" },
    nearPageOne: { total: 1, top: [{ query: "bank reconciliation", impressions: 30 }] },
    competing: { total: 0, top: [] },
  });
});

test("an API that's off answers 409 with whether this is self-hosted", async () => {
  w.sc.failNext("api_disabled");
  const r = await w.call(`${base}/summary`, cookie);
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ error: "api_disabled", selfHost: true });
});

test("without a session nothing is shown", async () => {
  expect((await w.call(base)).status).toBe(401);
});

test("briefs: the latest run, then this week's run once, as the person who pressed it", async () => {
  w.clock.at = new Date("2026-11-06T12:00:00Z");
  w.sc.rows.splice(0, w.sc.rows.length, { keys: ["bank reconciliation", "https://example.com/a"], clicks: 1, impressions: 30, ctr: 0.03, position: 12 });
  expect(await (await w.call(`/api/w/${W}/seo/briefs`, cookie)).json()).toEqual({ note: null, ranThisWeek: false });
  const run = await w.call(`/api/w/${W}/seo/briefs/run`, cookie, { method: "POST" });
  expect(run.status).toBe(200);
  expect(await run.json()).toMatchObject({ week: "2026-11-02", by: "person", started: [{ page: "https://example.com/a", query: "bank reconciliation", selector: "near_page_one" }], skipped: [], stopped: null });
  expect(w.started.at(-1)).toMatchObject({ startedBy: userId });
  expect(await (await w.call(`/api/w/${W}/seo/briefs`, cookie)).json()).toMatchObject({ ranThisWeek: true, note: { week: "2026-11-02" } });
  const again = await w.call(`/api/w/${W}/seo/briefs/run`, cookie, { method: "POST" });
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({ error: "already_ran" });
});

test("writing one Brief: a row from the candidates starts it as the person who pressed; anything else is refused", async () => {
  w.clock.at = new Date("2026-11-06T12:00:00Z");
  w.sc.rows.splice(0, w.sc.rows.length, { keys: ["bank reconciliation", "https://example.com/a"], clicks: 1, impressions: 30, ctr: 0.03, position: 12 });
  const write = (body: unknown) => w.call(`/api/w/${W}/seo/briefs/write`, cookie, { method: "POST", body });
  const r = await write({ page: "https://example.com/a", query: "bank reconciliation" });
  expect(r.status).toBe(202);
  expect(await r.json()).toEqual({ runId: expect.any(String) });
  expect(w.started.at(-1)).toMatchObject({ agent: "page_brief", startedBy: userId, input: { candidate: { selector: "near_page_one", page: "https://example.com/a", query: "bank reconciliation" } } });
  const other = await write({ page: "https://example.com/a", query: "something else" });
  expect(other.status).toBe(404);
  expect(await other.json()).toEqual({ error: "not_a_candidate" });
  expect((await write({ page: "" })).status).toBe(400);
});

test("the Brief history is empty before any Brief", async () => {
  const r = await w.call(`/api/w/${W}/seo/briefs/history`, cookie);
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ briefs: [], writing: [] });
});
