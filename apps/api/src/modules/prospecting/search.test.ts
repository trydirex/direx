// SPDX-License-Identifier: AGPL-3.0-only
// Search runs over HTTP with a fake Discovery, real sessions and a real queue. Without discovery, as
// on a deployment with no extension installed, search refuses with not_available.
import { afterAll, beforeAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createBoss } from "../../jobs/boss";
import { noDiscovery, type Discovery } from "../extensions/index";
import { testIdentity } from "./fixtures/support";
import { COMPANY_READ_QUEUE, createRuns, ESTIMATE_DEFAULTS, MAX_COMPANIES, prospectingRoutes, type CompanyRead, type SearchLine } from "./index";

const boss = createBoss();
await boss.start();
await boss.createQueue(COMPANY_READ_QUEUE);

type Found = Awaited<ReturnType<Discovery["search"]>>;
const searches: { workspaceId: string; terms: string[]; limit: number }[] = [];
let found: Found = [];
const SEARCH_USD = 0.5;
const fake: Discovery = {
  estimate: async () => ({ usd: SEARCH_USD }),
  search: async (workspaceId, terms, limit) => {
    searches.push({ workspaceId, terms, limit });
    return found;
  },
};
let discovery: Discovery = fake;
/** Whether names runs go to a subscription, as models would answer. */
let subscription = false;

const { routes, call, signIn, createOrg, addMember } = testIdentity();
routes.route(
  "/",
  prospectingRoutes({
    runs: () => createRuns({ boss }),
    handovers: () => {
      throw new Error("search needs no hand-overs");
    },
    terms: () => {
      throw new Error("search needs no terms run");
    },
    discovery: () => discovery,
    namesFree: async () => subscription,
  }),
);

const owner = await signIn();
const U = ((await (await call("/api/me", owner)).json()) as { user: { id: string } }).user.id;
const newWorkspace = async () => (await createOrg(owner)).workspace.id;
const post = (path: string, cookie: string, body: unknown) => call(path, cookie, { method: "POST", body });
const body = (extra: Record<string, unknown> = {}) => ({ terms: ["bookkeeping firms in Ohio"], limit: 3, signals: ["hiring"], ...extra });
type Searched = { runId: string; status: string; searchUsd: number; results: SearchLine[]; error?: string; terms?: string[]; usd?: number; signals?: string[] };
async function search(W: string, extra: Record<string, unknown> = {}, cookie = owner) {
  const r = await post(`/api/w/${W}/prospecting/runs`, cookie, body({ confirmedUsd: 100, ...extra }));
  return { status: r.status, body: (await r.json()) as Searched };
}
async function estimate(W: string, extra: Record<string, unknown> = {}, cookie = owner) {
  const r = await post(`/api/w/${W}/prospecting/estimate`, cookie, body(extra));
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
const run = async (W: string, id: string) => (await (await call(`/api/w/${W}/prospecting/runs/${id}`, owner)).json()) as Record<string, unknown>;
const companies = async (W: string) => ((await (await call(`/api/w/${W}/prospecting/companies`, owner)).json()) as { companies: { id: string; domain: string; website: string; name: string | null }[] }).companies;
const queued = async (companyId: string) => (await boss.findJobs<CompanyRead>(COMPANY_READ_QUEUE, { data: { companyId } })).map((j) => j.data);
const result = (domain: string, name = domain) => ({ domain, name, source: `https://${domain}/about?ref=search` });

let c: Awaited<ReturnType<typeof appClient>>;
beforeAll(async () => {
  c = await appClient();
});
afterAll(async () => {
  await c.end();
  await boss.stop({ graceful: false, close: true });
});

async function q<T = Record<string, unknown>>(W: string, text: string, params: unknown[] = []): Promise<T[]> {
  await c.query("begin");
  try {
    await c.query("select set_config('app.workspace_id', $1, true)", [W]);
    const r = await c.query(text, params);
    await c.query("commit");
    return r.rows as T[];
  } catch (e) {
    await c.query("rollback");
    throw e;
  }
}

test("the estimate is the search plus every company read and every kept address checked, at worst case", async () => {
  const W = await newWorkspace();
  const d = ESTIMATE_DEFAULTS;
  expect(await estimate(W, { limit: 10 })).toEqual({
    status: 200,
    body: {
      searchUsd: SEARCH_USD,
      namesUsd: 10 * d.namesUsdPerCompany,
      verifyUsd: 10 * d.addressesPerCompany * d.verifyUsdPerAddress,
      totalUsd: SEARCH_USD + 10 * d.namesUsdPerCompany + 10 * d.addressesPerCompany * d.verifyUsdPerAddress,
      limit: 10,
      namesFree: false,
      defaults: d,
    },
  });
  expect((await estimate(W, { limit: MAX_COMPANIES + 1 })).status).toBe(400);
  expect((await estimate(W, { terms: [] })).status).toBe(400);
});

test("a search makes one run, one company and one queued read per new domain, keeping only domain and name", async () => {
  const W = await newWorkspace();
  found = [result("www.acme.test", " Acme Books "), result("https://beta.test/x"), result("acme.test", "Acme again"), result("gmail.com")];
  searches.length = 0;
  const { status, body: b } = await search(W, { terms: ["  bookkeeping firms in Ohio "] });
  expect(status).toBe(200);
  expect(searches).toEqual([{ workspaceId: W, terms: ["bookkeeping firms in Ohio"], limit: 3 }]);
  expect(b).toEqual({
    runId: expect.any(String),
    status: "running",
    searchUsd: SEARCH_USD,
    results: [
      { domain: "acme.test", name: "Acme Books", ok: true, companyId: expect.any(String), runId: b.runId },
      { domain: "beta.test", name: null, ok: true, companyId: expect.any(String), runId: b.runId },
    ],
  });
  expect((await companies(W)).map((x) => [x.domain, x.website, x.name]).sort()).toEqual([
    ["acme.test", "https://acme.test/", "Acme Books"],
    ["beta.test", "https://beta.test/", null],
  ]);
  for (const r of b.results) expect(await queued(r.companyId!)).toEqual([{ workspaceId: W, companyId: r.companyId }]);
  expect(await run(W, b.runId)).toMatchObject({ source: "search", terms: ["bookkeeping firms in Ohio"], status: "running", signals: ["hiring"], confirmedUsd: 100, vendorCostUsd: SEARCH_USD, progress: { companies: 2, readPending: 2 } });
  const [row] = await q<{ terms: string[]; search_cost_micros: string; company_limit: number }>(W, "select terms, search_cost_micros::text, company_limit from prospect_runs where id = $1", [b.runId]);
  expect(row).toEqual({ terms: ["bookkeeping firms in Ohio"], search_cost_micros: "500000", company_limit: 3 });
  // Nothing from a result but its domain and title is stored, so its URL is nowhere in the Workspace.
  expect(JSON.stringify(await q(W, "select * from prospect_companies"))).not.toContain("ref=search");
});

test("a company already known is reported, not read or charged again", async () => {
  const W = await newWorkspace();
  found = [result("acme.test")];
  const first = await search(W);
  found = [result("acme.test"), result("new.test")];
  const { body: b } = await search(W, { confirmedUsd: SEARCH_USD + ESTIMATE_DEFAULTS.namesUsdPerCompany + ESTIMATE_DEFAULTS.addressesPerCompany * ESTIMATE_DEFAULTS.verifyUsdPerAddress });
  expect(b.status).toBe("running");
  expect(b.results).toEqual([
    { domain: "acme.test", name: null, ok: false, reason: "already_known", companyId: first.body.results[0]!.companyId, runId: first.body.runId },
    { domain: "new.test", name: null, ok: true, companyId: expect.any(String), runId: b.runId },
  ]);
  expect(await queued(first.body.results[0]!.companyId!)).toHaveLength(1);
  expect(await companies(W)).toHaveLength(2);

  // Every result known: the run is done at once, with the search's cost and no company.
  const again = await search(W);
  expect(again.body).toMatchObject({ status: "done", results: [{ reason: "already_known" }, { reason: "already_known" }] });
  expect(await run(W, again.body.runId)).toMatchObject({ status: "done", finishedAt: expect.any(String), vendorCostUsd: SEARCH_USD, progress: { companies: 0 } });
});

test("a search takes at most its limit and never more than a run may read", async () => {
  const W = await newWorkspace();
  found = Array.from({ length: MAX_COMPANIES + 20 }, (_, i) => result(`cap${i}.test`));
  searches.length = 0;
  const { body: b } = await search(W, { limit: MAX_COMPANIES, confirmedUsd: 1_000 });
  expect(searches[0]!.limit).toBe(MAX_COMPANIES);
  expect(b.results).toHaveLength(MAX_COMPANIES);
  expect(b.results.every((r) => r.ok)).toBe(true);
  expect((await search(W, { limit: MAX_COMPANIES + 1 })).status).toBe(400);
});

test("a run stops at its confirmed amount and keeps what that amount covers", async () => {
  const W = await newWorkspace();
  const perCompany = ESTIMATE_DEFAULTS.namesUsdPerCompany + ESTIMATE_DEFAULTS.addressesPerCompany * ESTIMATE_DEFAULTS.verifyUsdPerAddress;
  found = [result("one.test"), result("two.test"), result("three.test")];
  const { body: b } = await search(W, { confirmedUsd: SEARCH_USD + 2 * perCompany });
  expect(b.status).toBe("stopped");
  expect(b.results.map((r) => [r.domain, r.ok, r.reason])).toEqual([
    ["one.test", true, undefined],
    ["two.test", true, undefined],
    ["three.test", false, "over_amount"],
  ]);
  expect(await run(W, b.runId)).toMatchObject({ status: "stopped", finishedAt: expect.any(String), confirmedUsd: SEARCH_USD + 2 * perCompany, vendorCostUsd: SEARCH_USD, progress: { companies: 2 } });

  // The search alone reaches the amount: it is recorded, and nothing is read.
  found = [result("four.test")];
  const spent = await search(W, { confirmedUsd: SEARCH_USD });
  expect(spent.body).toMatchObject({ status: "stopped", results: [{ domain: "four.test", ok: false, reason: "over_amount" }] });
  expect(await run(W, spent.body.runId)).toMatchObject({ status: "stopped", vendorCostUsd: SEARCH_USD, progress: { companies: 0 } });

  // Below the search's own estimate nothing starts, and the search is never called.
  searches.length = 0;
  expect(await search(W, { confirmedUsd: SEARCH_USD - 0.01 })).toMatchObject({ status: 400, body: { error: "below_estimate", usd: SEARCH_USD } });
  expect(searches).toEqual([]);
  expect(await companies(W)).toHaveLength(2);
});

test("a term holding Person data is refused by name, and nothing reaches the search", async () => {
  const W = await newWorkspace();
  const [r] = await q<{ id: string }>(W, `insert into prospect_runs (workspace_id, source, company_limit, confirmed_micros, confirmed_by, created_at, updated_at) values ($1, 'pasted', 1, 0, $2, now(), now()) returning id`, [W, U]);
  const [co] = await q<{ id: string }>(W, `insert into prospect_companies (workspace_id, domain, website, first_run_id, created_at, updated_at) values ($1, 'kim.test', 'https://kim.test/', $2, now(), now()) returning id`, [W, r!.id]);
  await q(W, `insert into prospect_people (workspace_id, company_id, first, last, created_at) values ($1, $2, 'Kim', 'Lee', now())`, [W, co!.id]);
  searches.length = 0;
  const terms = ["accountants", "firms like kim lee's", "kim@acme.test", "www.acme.test"];
  expect(await search(W, { terms })).toMatchObject({ status: 400, body: { error: "person_data", terms: terms.slice(1) } });
  expect(await estimate(W, { terms })).toMatchObject({ status: 400, body: { error: "person_data", terms: terms.slice(1) } });
  expect(await search(W, { signals: ["funding"] })).toMatchObject({ status: 400, body: { error: "unknown_signal", signals: ["funding"] } });
  expect(searches).toEqual([]);
  expect((await q(W, "select id from prospect_runs where source = 'search'")).length).toBe(0);
});

test("with no discovery installed, the estimate and the search say not_available and store nothing", async () => {
  const W = await newWorkspace();
  discovery = noDiscovery;
  try {
    expect(await estimate(W)).toMatchObject({ status: 409, body: { error: "not_available" } });
    expect(await search(W)).toMatchObject({ status: 409, body: { error: "not_available" } });
  } finally {
    discovery = fake;
  }
  expect(await companies(W)).toEqual([]);

  // A pasted list still works.
  const pasted = await post(`/api/w/${W}/prospecting/runs/pasted`, owner, { websites: ["acme.test"], signals: [], confirmedUsd: 0 });
  expect(pasted.status).toBe(200);

  // Routes given no discovery at all refuse the same way.
  const bare = testIdentity();
  bare.routes.route("/", prospectingRoutes({ runs: () => createRuns({ boss }), handovers: () => ({}) as never, terms: () => ({}) as never }));
  const someone = await bare.signIn();
  const theirs = (await bare.createOrg(someone)).workspace.id;
  expect((await bare.call(`/api/w/${theirs}/prospecting/estimate`, someone, { method: "POST", body: body() })).status).toBe(409);
});

test("an editor estimates, only an approver searches, and another Workspace gets 404", async () => {
  const W = await newWorkspace();
  found = [];
  const roles = {
    admin: (await addMember(owner, W, "admin")).cookie,
    marketer: (await addMember(owner, W, "marketer")).cookie,
    contributor: (await addMember(owner, W, "contributor")).cookie,
    viewer: (await addMember(owner, W, "viewer")).cookie,
  };
  for (const cookie of [roles.admin, roles.marketer, roles.contributor]) expect((await estimate(W, {}, cookie)).status).toBe(200);
  expect((await estimate(W, {}, roles.viewer)).status).toBe(403);
  expect((await search(W, {}, roles.admin)).status).toBe(200);
  expect((await search(W, {}, roles.marketer)).status).toBe(200);
  expect((await search(W, {}, roles.contributor)).status).toBe(403);
  expect((await search(W, {}, roles.viewer)).status).toBe(403);

  const stranger = await signIn();
  await createOrg(stranger);
  searches.length = 0;
  expect((await estimate(W, {}, stranger)).status).toBe(404);
  expect((await search(W, {}, stranger)).status).toBe(404);
  expect(searches).toEqual([]);
});

test("a pasted list is estimated per company at the worst case, without needing a search installed", async () => {
  const W = await newWorkspace();
  const d = ESTIMATE_DEFAULTS;
  discovery = noDiscovery;
  try {
    const r = await call(`/api/w/${W}/prospecting/estimate/per-company`, owner);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ usd: d.namesUsdPerCompany + d.addressesPerCompany * d.verifyUsdPerAddress, namesFree: false, searchAvailable: false });
  } finally {
    discovery = fake;
  }
});

test("on a subscription, names add nothing to the estimate, and the same amount reads more companies", async () => {
  const W = await newWorkspace();
  const d = ESTIMATE_DEFAULTS;
  subscription = true;
  try {
    expect((await estimate(W, { limit: 10 })).body).toMatchObject({ namesUsd: 0, namesFree: true, totalUsd: SEARCH_USD + 10 * d.addressesPerCompany * d.verifyUsdPerAddress, defaults: { namesUsdPerCompany: 0 } });
    expect(await (await call(`/api/w/${W}/prospecting/estimate/per-company`, owner)).json()).toEqual({ usd: d.addressesPerCompany * d.verifyUsdPerAddress, namesFree: true, searchAvailable: true });
    // At $1 a company this amount covered two; with names free it covers all three.
    found = [result("sub-one.test"), result("sub-two.test"), result("sub-three.test")];
    const { body: b } = await search(W, { confirmedUsd: SEARCH_USD + 2 * (d.namesUsdPerCompany + d.addressesPerCompany * d.verifyUsdPerAddress) });
    expect(b.status).toBe("running");
    expect(b.results.every((r) => r.ok)).toBe(true);
  } finally {
    subscription = false;
  }
});
