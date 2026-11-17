// SPDX-License-Identifier: AGPL-3.0-only
// Pasted runs over HTTP, with real sessions, a real queue and a fake site for the one read that runs.
import { afterAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createBoss } from "../../jobs/boss";
import { createFetchHtml } from "../agents/index";
import { testIdentity } from "./fixtures/support";
import { COMPANY_READ_QUEUE, COMPANY_VERIFY_QUEUE, createCompanyReader, createRuns, MAX_COMPANIES, prospectingRoutes, type CompanyRead, type PastedLine } from "./index";

const boss = createBoss();
await boss.start();
await boss.createQueue(COMPANY_READ_QUEUE);
await boss.createQueue(COMPANY_VERIFY_QUEUE);
const db = await appClient();
afterAll(async () => {
  await db.end();
  await boss.stop({ graceful: false, close: true });
});

/** Runs SQL as the app role inside one Workspace, as the verifier would leave the rows. */
async function inW(W: string, text: string, params: unknown[] = []) {
  await db.query("begin");
  try {
    await db.query("select set_config('app.workspace_id', $1, true)", [W]);
    const r = await db.query(text, params);
    await db.query("commit");
    return r.rows as Record<string, string>[];
  } catch (e) {
    await db.query("rollback");
    throw e;
  }
}

const { routes, call, signIn, createOrg, addMember } = testIdentity();
routes.route("/", prospectingRoutes({
    runs: () => createRuns({ boss }),
    handovers: () => {
      throw new Error("runs need no hand-overs");
    },
    terms: () => {
      throw new Error("runs need no terms");
    },
  }));

const owner = await signIn();
const newWorkspace = async () => (await createOrg(owner)).workspace.id;
const send = (path: string, cookie: string, body: unknown) => call(path, cookie, { method: "POST", body });
type Pasted = { runId: string | null; results: PastedLine[] };
async function paste(W: string, websites: string[], extra: { signals?: string[]; confirmedUsd?: number } = {}) {
  const r = await send(`/api/w/${W}/prospecting/runs/pasted`, owner, { websites, signals: extra.signals ?? ["hiring"], confirmedUsd: extra.confirmedUsd ?? 2.5 });
  return { status: r.status, body: (await r.json()) as Pasted & { error?: string; max?: number; signals?: string[] } };
}
type Company = { id: string; domain: string; website: string; runId: string; readStatus: string; readReason: string | null; namesStatus: string | null; namesReason: string | null; reviewItemId: string | null };
const companies = async (W: string, cursor?: string, runId?: string, cookie = owner) => {
  const q = new URLSearchParams({ ...(cursor && { cursor }), ...(runId && { runId }) });
  return (await (await call(`/api/w/${W}/prospecting/companies?${q}`, cookie)).json()) as { companies: Company[]; next: string | null };
};
const run = async (W: string, id: string) => (await (await call(`/api/w/${W}/prospecting/runs/${id}`, owner)).json()) as Record<string, unknown>;
const queued = async (companyId: string) => (await boss.findJobs<CompanyRead>(COMPANY_READ_QUEUE, { data: { companyId } })).map((j) => j.data);

test("a paste becomes one run, one company and one queued read per new website", async () => {
  const W = await newWorkspace();
  const { status, body } = await paste(W, ["https://www.acme.test/about", "beta.test"]);
  expect(status).toBe(200);
  expect(body.runId).toEqual(expect.any(String));
  expect(body.results).toMatchObject([
    { line: 1, ok: true, runId: body.runId },
    { line: 2, ok: true, runId: body.runId },
  ]);
  const { companies: list } = await companies(W);
  expect(list.map((c) => [c.domain, c.website, c.readStatus, c.namesStatus]).sort()).toEqual([
    ["acme.test", "https://www.acme.test/", "pending", null],
    ["beta.test", "https://beta.test/", "pending", null],
  ]);
  for (const r of body.results) expect(await queued(r.companyId!)).toEqual([{ workspaceId: W, companyId: r.companyId }]);
  expect(await run(W, body.runId!)).toMatchObject({ source: "pasted", status: "running", signals: ["hiring"], confirmedUsd: 2.5, vendorCostUsd: 0, finishedAt: null, progress: { companies: 2, readPending: 2 } });
});

test("each company in the list carries its Signals with quote, page and date, and only its own", async () => {
  const W = await newWorkspace();
  const { body } = await paste(W, ["acme.test", "beta.test"]);
  const acme = body.results[0]!.companyId!;
  const [page] = await inW(W, "insert into prospect_snapshots (workspace_id, company_id, page_url, digest, text, read_at) values ($1, $2, 'https://acme.test/careers', 'd', 'We are hiring.', now()) returning id", [W, acme]);
  await inW(W, "insert into prospect_signals (workspace_id, company_id, type, quote, page_url, snapshot_id, observed_on, created_at) values ($1, $2, 'hiring', 'We are hiring.', 'https://acme.test/careers', $3, '2026-11-02', now())", [W, acme, page!.id]);
  const list = (await companies(W, undefined, body.runId!)).companies as (Company & { signals: unknown[] })[];
  expect(list.find((c) => c.id === acme)!.signals).toEqual([{ type: "hiring", quote: "We are hiring.", pageUrl: "https://acme.test/careers", observedOn: "2026-11-02" }]);
  expect(list.find((c) => c.id !== acme)!.signals).toEqual([]);
});

test("duplicates in a paste and companies already known are reported, not read again", async () => {
  const W = await newWorkspace();
  const first = await paste(W, ["acme.test"]);
  const { body } = await paste(W, ["http://ACME.test", "beta.test", "https://beta.test/contact", "", "not a site", "gmail.com", "ftp://gamma.test"]);
  expect(body.results).toEqual([
    { line: 1, website: "http://ACME.test", ok: false, reason: "already_known", companyId: first.body.results[0]!.companyId, runId: first.body.runId },
    { line: 2, website: "beta.test", ok: true, companyId: expect.any(String), runId: body.runId },
    { line: 3, website: "https://beta.test/contact", ok: false, reason: "duplicate", sameAs: 2 },
    { line: 5, website: "not a site", ok: false, reason: "invalid_website" },
    { line: 6, website: "gmail.com", ok: false, reason: "invalid_website" },
    { line: 7, website: "ftp://gamma.test", ok: false, reason: "invalid_website" },
  ]);
  expect(await queued(first.body.results[0]!.companyId!)).toHaveLength(1);
  expect((await companies(W)).companies).toHaveLength(2);
});

test("a double submit stores nothing twice, even when both arrive at once", async () => {
  const W = await newWorkspace();
  const websites = ["one.test", "two.test", "three.test"];
  const [a, b] = await Promise.all([paste(W, websites), paste(W, websites)]);
  const runs = [a.body.runId, b.body.runId].filter(Boolean);
  expect(runs).toHaveLength(1);
  const later = a.body.runId ? b : a;
  expect(later.body.results.map((r) => [r.reason, r.runId])).toEqual(websites.map(() => ["already_known", runs[0]]));
  const { companies: list } = await companies(W);
  expect(list).toHaveLength(3);
  for (const c of list) expect(await queued(c.id)).toHaveLength(1);
});

test("refusals say why and store nothing", async () => {
  const W = await newWorkspace();
  expect(await paste(W, [" ", ""])).toMatchObject({ status: 400, body: { error: "empty" } });
  expect(await paste(W, ["acme.test"], { signals: ["hiring", "funding"] })).toMatchObject({ status: 400, body: { error: "unknown_signal", signals: ["funding"] } });
  const tooMany = Array.from({ length: MAX_COMPANIES + 1 }, (_, i) => `site${i}.test`);
  expect(await paste(W, tooMany)).toMatchObject({ status: 400, body: { error: "too_many", max: MAX_COMPANIES } });
  expect((await send(`/api/w/${W}/prospecting/runs/pasted`, owner, { websites: ["acme.test"], signals: [], confirmedUsd: -1 })).status).toBe(400);
  expect((await companies(W)).companies).toEqual([]);

  // The cap counts companies to read, so known ones don't count against it.
  expect((await paste(W, tooMany.slice(0, 1))).status).toBe(200);
  expect(await paste(W, tooMany)).toMatchObject({ status: 200, body: { results: expect.arrayContaining([expect.objectContaining({ reason: "already_known" })]) } });
  expect((await call(`/api/w/${W}/prospecting/runs/${crypto.randomUUID()}`, owner)).status).toBe(404);
});

test("a site that refuses robots says why, and the run is done once every company is settled", async () => {
  const W = await newWorkspace();
  const { body } = await paste(W, ["blocked.test"]);
  const reader = createCompanyReader({
    fetchHtml: createFetchHtml({
      maxChars: Infinity,
      resolve: async () => [{ address: "93.184.216.34" }],
      request: async (url) => new Response(url.pathname === "/robots.txt" ? "User-agent: *\nDisallow: /" : "<p>home</p>", { headers: { "content-type": "text/plain" } }),
    }),
  });
  for (const job of await queued(body.results[0]!.companyId!)) await reader.read(job);
  expect((await companies(W)).companies).toMatchObject([{ domain: "blocked.test", readStatus: "not_read", readReason: "robots_txt", namesStatus: "skipped", namesReason: "site_not_read" }]);
  expect(await run(W, body.runId!)).toMatchObject({ status: "done", finishedAt: expect.any(String), progress: { companies: 1, readPending: 0, notRead: 1, namesSkipped: 1 } });
});

test("companies come a page at a time", async () => {
  const W = await newWorkspace();
  const websites = Array.from({ length: 150 }, (_, i) => `page${i}.test`);
  expect((await paste(W, websites)).status).toBe(200);
  const first = await companies(W);
  expect(first.companies).toHaveLength(100);
  expect(first.next).toBe(first.companies[99]!.id);
  const second = await companies(W, first.next!);
  expect(second.companies).toHaveLength(50);
  expect(second.next).toBeNull();
  expect(new Set([...first.companies, ...second.companies].map((c) => c.domain)).size).toBe(150);
});

test("one run's companies come a page at a time, and nothing from another run or Workspace", async () => {
  const W = await newWorkspace();
  const before = (await paste(W, ["earlier.test"])).body.runId!;
  const { body } = await paste(W, Array.from({ length: 130 }, (_, i) => `run${i}.test`));
  const after = (await paste(W, ["later.test"])).body.runId!;
  const first = await companies(W, undefined, body.runId!);
  expect(first.companies).toHaveLength(100);
  expect(first.companies.every((c) => c.runId === body.runId && c.reviewItemId === null)).toBe(true);
  const second = await companies(W, first.next!, body.runId!);
  expect(second.companies).toHaveLength(30);
  expect(second.next).toBeNull();
  expect(new Set([...first.companies, ...second.companies].map((c) => c.domain)).size).toBe(130);
  expect((await companies(W, undefined, before)).companies.map((c) => c.domain)).toEqual(["earlier.test"]);
  expect((await companies(W, undefined, after)).companies.map((c) => c.domain)).toEqual(["later.test"]);

  // Another Workspace asking for this run's id, in its own Workspace, gets nothing.
  const stranger = await signIn();
  const theirs = (await createOrg(stranger)).workspace.id;
  expect(await companies(theirs, undefined, body.runId!, stranger)).toEqual({ companies: [], next: null });
});

test("anyone in the Workspace reads, only an approver starts a run, and another Workspace gets 404", async () => {
  const W = await newWorkspace();
  const { body } = await paste(W, ["acme.test"]);
  const roles = {
    admin: (await addMember(owner, W, "admin")).cookie,
    marketer: (await addMember(owner, W, "marketer")).cookie,
    contributor: (await addMember(owner, W, "contributor")).cookie,
    viewer: (await addMember(owner, W, "viewer")).cookie,
  };
  const start = (cookie: string, site: string) => send(`/api/w/${W}/prospecting/runs/pasted`, cookie, { websites: [site], signals: [], confirmedUsd: 0 });
  for (const cookie of Object.values(roles)) {
    expect((await call(`/api/w/${W}/prospecting/runs/${body.runId}`, cookie)).status).toBe(200);
    expect((await call(`/api/w/${W}/prospecting/companies`, cookie)).status).toBe(200);
  }
  expect((await start(roles.admin, "admin.test")).status).toBe(200);
  expect((await start(roles.marketer, "marketer.test")).status).toBe(200);
  expect((await start(roles.contributor, "contributor.test")).status).toBe(403);
  expect((await start(roles.viewer, "viewer.test")).status).toBe(403);

  const stranger = await signIn();
  const theirs = (await createOrg(stranger)).workspace.id;
  expect((await call(`/api/w/${W}/prospecting/runs/${body.runId}`, stranger)).status).toBe(404);
  expect((await call(`/api/w/${W}/prospecting/companies`, stranger)).status).toBe(404);
  expect((await start(stranger, "stranger.test")).status).toBe(404);
  // Their own Workspace can't see this run either.
  expect((await call(`/api/w/${theirs}/prospecting/runs/${body.runId}`, stranger)).status).toBe(404);
  expect((await (await call(`/api/w/${theirs}/prospecting/companies`, stranger)).json()) as unknown).toEqual({ companies: [], next: null });
});

test("the Workspace's runs are listed newest first, each with how many companies it found", async () => {
  const W = await newWorkspace();
  const one = (await paste(W, ["one.test"])).body.runId!;
  const two = (await paste(W, ["two.test", "three.test"], { confirmedUsd: 4 })).body.runId!;
  const r = await call(`/api/w/${W}/prospecting/runs`, owner);
  expect(r.status).toBe(200);
  const { runs } = (await r.json()) as { runs: { id: string; createdAt: string }[] };
  expect(runs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: one, source: "pasted", status: "running", companies: 1, confirmedUsd: 2.5, vendorCostUsd: 0, finishedAt: null }),
      expect.objectContaining({ id: two, companies: 2, confirmedUsd: 4 }),
    ]),
  );
  expect(runs).toHaveLength(2);
  expect(runs.map((x) => x.createdAt)).toEqual([...runs.map((x) => x.createdAt)].sort().reverse());
  // Another Workspace sees none of them.
  expect(((await (await call(`/api/w/${await newWorkspace()}/prospecting/runs`, owner)).json()) as { runs: unknown[] }).runs).toEqual([]);
});

test("a run counts addresses the checking service hasn't answered, and Check again queues its accepted companies only", async () => {
  const W = await newWorkspace();
  const { body } = await paste(W, ["accepted.test", "waiting.test"]);
  const [accepted, waiting] = body.results.map((r) => r.companyId!);
  await inW(W, "update prospect_companies set state = 'accepted' where id = $1", [accepted]);
  const [page] = await inW(W, "insert into prospect_snapshots (workspace_id, company_id, page_url, digest, text, read_at) values ($1, $2, 'https://accepted.test/', 'd', 'Ana Ruiz', now()) returning id", [W, accepted]);
  const address = (email: string, source: string, result: string | null, leftOut: string | null) =>
    inW(
      W,
      `insert into prospect_addresses (workspace_id, company_id, email, kind, source, pattern, name, snapshot_id, read_at, notice_found, left_out_reason, verification_result, verified_at, created_at)
       values ($1, $2, $3, 'named', $4::text, case when $4::text = 'guessed' then 'first' end, 'Ana Ruiz', $5, now(), false, $6, $7::text, case when $7::text is null then null else now() end, now())`,
      [W, accepted, email, source, page!.id, leftOut, result],
    );
  await address("sales@accepted.test", "published", null, null);
  await address("team@accepted.test", "published", "deliverable", null);
  await address("ana@accepted.test", "guessed", "unknown", "not_deliverable");
  await address("info@accepted.test", "published", null, "generic_address");
  expect(await run(W, body.runId!)).toMatchObject({ unchecked: 2 });

  const again = (cookie: string, id = body.runId!) => send(`/api/w/${W}/prospecting/runs/${id}/check-again`, cookie, {});
  const r = await again(owner);
  expect(r.status).toBe(202);
  expect(await r.json()).toEqual({ queued: 1 });
  const jobs = async (companyId: string) => (await boss.findJobs(COMPANY_VERIFY_QUEUE, { data: { companyId } })).length;
  expect(await jobs(accepted!)).toBe(1);
  expect(await jobs(waiting!)).toBe(0);

  expect((await again((await addMember(owner, W, "contributor")).cookie)).status).toBe(403);
  expect((await again(owner, crypto.randomUUID())).status).toBe(404);
});
