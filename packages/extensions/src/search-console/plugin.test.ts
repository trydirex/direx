// SPDX-License-Identifier: AGPL-3.0-only
import { invoke } from "../test-wire";
import { expect, test } from "vitest";
import { createFakeSearchConsole } from "./fake-search-console";
import { createSearchConsolePlugin, SearchConsoleError } from "./plugin";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const SITE = "sc-domain:example.com";
const ctx = (accessToken: string) => ({ workspaceId: "w1", log: () => {}, credential: { accessToken, expiresAt: "2026-11-06T13:00:00Z" } });
const setup = (rows = 3) => {
  const sc = createFakeSearchConsole({ rows: Array.from({ length: rows }, (_, i) => ({ keys: [`q${i}`], clicks: i, impressions: 10 * i, ctr: 0.1, position: 2.5 })) });
  const plugin = createSearchConsolePlugin({ fetch: sc.fetch, now: () => NOW });
  return { sc, plugin, q: (name: string, input: unknown) => plugin.queries[name]!(input, ctx(sc.token)) };
};
const range = { siteUrl: SITE, startDate: "2026-10-01", endDate: "2026-10-28", dimensions: ["query"] };

test("lists the properties the account can see", async () => {
  const { sc, q } = setup();
  sc.sites.push({ siteUrl: "https://example.org/", permissionLevel: "siteUnverifiedUser" });
  expect(await q("search.properties", null)).toEqual([
    { siteUrl: SITE, permissionLevel: "siteOwner" },
    { siteUrl: "https://example.org/", permissionLevel: "siteUnverifiedUser" },
  ]);
  expect(await q("search.properties", {})).toHaveLength(2);
  await expect(q("search.properties", { siteUrl: SITE })).rejects.toThrow("search.properties takes no input");
});

test("no properties is an empty list", async () => {
  const { sc, q } = setup();
  sc.sites.length = 0;
  expect(await q("search.properties", undefined)).toEqual([]);
});

test("analytics posts the range to the encoded property and maps the rows", async () => {
  const { sc, q } = setup(1);
  expect(await q("search.analytics", { ...range, dimensions: ["query", "page"] })).toEqual({ rows: [{ keys: ["q0"], clicks: 0, impressions: 0, ctr: 0.1, position: 2.5 }] });
  expect(sc.calls[0]).toEqual({
    method: "POST",
    path: "/sites/sc-domain%3Aexample.com/searchAnalytics/query",
    body: { startDate: "2026-10-01", endDate: "2026-10-28", dimensions: ["query", "page"], rowLimit: 25_000, startRow: 0 },
  });
});

test("no rows from Google is an empty list", async () => {
  const { q } = setup(0);
  expect(await q("search.analytics", range)).toEqual({ rows: [] });
});

test("pages with startRow across two pages", async () => {
  const { sc, q } = setup(3);
  const first = (await q("search.analytics", { ...range, rowLimit: 2 })) as { rows: { keys: string[] }[] };
  const second = (await q("search.analytics", { ...range, rowLimit: 2, startRow: 2 })) as { rows: { keys: string[] }[] };
  expect([...first.rows, ...second.rows].map((r) => r.keys[0])).toEqual(["q0", "q1", "q2"]);
  expect(second.rows).toHaveLength(1);
  expect(sc.calls.map((c) => (c.body as { startRow: number }).startRow)).toEqual([0, 2]);
});

test.each([
  ["a date not in YYYY-MM-DD", { startDate: "2026/10/01" }, /startDate/],
  ["an impossible date", { endDate: "2026-02-30" }, /endDate/],
  ["startDate after endDate", { startDate: "2026-10-29" }, /startDate is after endDate/],
  ["an endDate in the future", { endDate: "2026-11-07" }, /endDate is in the future/],
  ["a startDate in the future", { startDate: "2026-11-07", endDate: "2026-11-08" }, /startDate is in the future/],
  ["a startDate more than 16 months back", { startDate: "2025-07-05" }, /startDate is more than 16 months back/],
  ["an endDate more than 16 months back", { startDate: "2025-07-01", endDate: "2025-07-05" }, /endDate is more than 16 months back/],
  ["no dimensions", { dimensions: [] }, /dimensions/],
  ["an unknown dimension", { dimensions: ["searchAppearance"] }, /dimensions/],
  ["a repeated dimension", { dimensions: ["query", "query"] }, /each dimension once/],
  ["a rowLimit of 0", { rowLimit: 0 }, /rowLimit/],
  ["a rowLimit over 25,000", { rowLimit: 25_001 }, /rowLimit/],
  ["a fractional rowLimit", { rowLimit: 1.5 }, /rowLimit/],
  ["a negative startRow", { startRow: -1 }, /startRow/],
  ["no siteUrl", { siteUrl: "" }, /siteUrl/],
  ["an unknown field", { type: "web" }, /input/],
])("refuses %s before calling Google", async (_name, change, message) => {
  const { sc, q } = setup();
  await expect(q("search.analytics", { ...range, ...change })).rejects.toThrow(message);
  expect(sc.calls).toHaveLength(0);
});

test("accepts the edges: today, and exactly 16 months back", async () => {
  const { q } = setup(0);
  expect(await q("search.analytics", { ...range, startDate: "2025-07-06", endDate: "2026-11-06" })).toEqual({ rows: [] });
});

test.each([
  ["revoked", 401, "needs_reconnecting", { reason: "credential_rejected" }],
  ["no_access", 403, "no_access", { reason: "provider_error", code: "no_access" }],
  ["api_disabled", 403, "api_disabled", { reason: "provider_error", code: "api_disabled" }],
] as const)("a %s answer is %i with reason %s, and no token in the message", async (kind, status, reason, typed) => {
  const { sc, q } = setup();
  sc.failNext(kind);
  const e = await q("search.analytics", range).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(SearchConsoleError);
  expect(e).toMatchObject({ status, ...typed, credentialRejected: status === 401 });
  expect((e as Error).message).toBe(`Search Console answered ${status}: ${reason}`);
  expect((e as Error).message).not.toContain(sc.token);
});

test("a token Google doesn't know asks for a reconnect", async () => {
  const { sc, plugin } = setup();
  await expect(plugin.queries["search.properties"]!(null, ctx("stale"))).rejects.toThrow("Search Console answered 401: needs_reconnecting");
  expect(sc.calls).toHaveLength(1);
});

test("a 429 is busy, with the wait in the message for the host to retry", async () => {
  const { sc, q } = setup();
  sc.failNext("rate_limited");
  const e = await q("search.properties", null).catch((x: unknown) => x);
  expect(e).toMatchObject({ status: 429, reason: "rate_limited", waitMs: 60_000, retryAfterMs: 60_000, credentialRejected: false });
  expect((e as Error).message).toBe("Search Console answered 429; wait 60000 ms: busy");
  expect(await q("search.properties", null)).toHaveLength(1);
});

test("another failure is failed", async () => {
  const broken = createSearchConsolePlugin({ fetch: (async () => new Response("oops", { status: 500 })) as unknown as typeof fetch, now: () => NOW });
  await expect(broken.queries["search.properties"]!(null, ctx("t"))).rejects.toMatchObject({ status: 500, reason: "provider_error" });
});

test("no token means not connected, and nothing is sent", async () => {
  const { sc, plugin } = setup();
  await expect(plugin.queries["search.properties"]!(null, { workspaceId: "w1", log: () => {}, credential: null })).rejects.toThrow("Search Console is not connected");
  await expect(plugin.queries["search.analytics"]!(range, { workspaceId: "w1", log: () => {}, credential: { key: "k" } })).rejects.toThrow("Search Console is not connected");
  expect(sc.calls).toHaveLength(0);
});

test("the plugin answers through the SDK's invoke", async () => {
  const { sc, plugin } = setup();
  const r = await invoke(plugin, "query", { capability: "search.properties", input: null, credential: ctx(sc.token).credential }, { workspaceId: "w1", log: () => {} });
  expect(r).toEqual({ output: [{ siteUrl: SITE, permissionLevel: "siteOwner" }] });
});
