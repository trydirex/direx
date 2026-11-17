// SPDX-License-Identifier: AGPL-3.0-only
// Cohorts over HTTP on a real database. Companies are seeded as review and verification leave them.
import { VERIFICATION_RESULTS as SDK_RESULTS } from "@direx/plugin-sdk";
import { afterAll, beforeAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { VERIFICATION_RESULTS } from "./domain/cohort-filter";
import { testIdentity } from "./fixtures/support";
import { createCohorts, prospectingRoutes, type Cohort, type CohortMember } from "./index";

const READ_AT = new Date("2026-11-02T12:00:00Z");
const { routes, call, signIn, createOrg, addMember } = testIdentity();
routes.route(
  "/",
  prospectingRoutes({
    runs: () => {
      throw new Error("cohorts need no runs");
    },
    handovers: () => {
      throw new Error("cohorts need no hand-overs");
    },
    terms: () => {
      throw new Error("cohorts need no terms");
    },
  }),
);
const owner = await signIn();
const U = ((await (await call("/api/me", owner)).json()) as { user: { id: string } }).user.id;
const newWorkspace = async () => (await createOrg(owner)).workspace.id;
let c: Awaited<ReturnType<typeof appClient>>;
beforeAll(async () => {
  c = await appClient();
});
afterAll(() => c.end());

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

type Address = { email: string; kind?: string; source?: "published" | "guessed"; name?: string; leftOut?: string; verification?: string };
type Seeded = { state?: string; country?: string | null; signals?: string[]; signalDaysAgo?: number; runId?: string; addresses: Address[] };
/** A company with one page, its signals and its addresses. Named addresses get a name, guesses a pattern. Each company gets its own run unless one is given. */
async function seed(W: string, domain: string, s: Seeded) {
  const [run] = s.runId
    ? [{ id: s.runId }]
    : await q<{ id: string }>(W, `insert into prospect_runs (workspace_id, source, company_limit, confirmed_micros, confirmed_by, created_at, updated_at) values ($1, 'pasted', 10, 0, $2, now(), now()) returning id`, [W, U]);
  const [company] = await q<{ id: string }>(
    W,
    `insert into prospect_companies (workspace_id, domain, website, country, first_run_id, read_status, names_status, state, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'read', 'done', $6, now(), now()) returning id`,
    [W, domain, `https://${domain}/`, s.country === undefined ? "GB" : s.country, run!.id, s.state ?? "accepted"],
  );
  const id = company!.id;
  const [page] = await q<{ id: string }>(W, `insert into prospect_snapshots (workspace_id, company_id, page_url, digest, text, read_at) values ($1, $2, $3, 'd', 'text', $4) returning id`, [
    W,
    id,
    `https://${domain}/team`,
    READ_AT,
  ]);
  for (const type of s.signals ?? []) {
    await q(
      W,
      `insert into prospect_signals (workspace_id, company_id, type, quote, page_url, snapshot_id, observed_on, created_at) values ($1, $2, $3, 'q', $4, $5, coalesce(current_date - $6::int, '2026-11-01'), now())`,
      [W, id, type, `https://${domain}/team`, page!.id, s.signalDaysAgo ?? null],
    );
  }
  for (const a of s.addresses) {
    const kind = a.kind ?? "function";
    const source = a.source ?? "published";
    await q(
      W,
      `insert into prospect_addresses (workspace_id, company_id, email, kind, source, pattern, name, role, snapshot_id, read_at, notice_found, left_out_reason, verification_result, verified_at, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, $11, $12, $13, now())`,
      [
        W,
        id,
        a.email,
        kind,
        source,
        source === "guessed" ? "first.last" : null,
        a.name ?? (kind === "named" ? "Jane Doe" : null),
        kind === "named" ? "Partner" : null,
        page!.id,
        READ_AT,
        a.leftOut ?? null,
        a.verification ?? null,
        a.verification ? READ_AT : null,
      ],
    );
  }
  return { id, snapshotId: page!.id, runId: run!.id };
}

type Detail = Cohort & { count: number; members: CohortMember[]; next: string | null };
const save = (W: string, body: unknown, cookie = owner) => call(`/api/w/${W}/prospecting/cohorts`, cookie, { method: "POST", body });
const put = (W: string, id: string, body: unknown, cookie = owner) => call(`/api/w/${W}/prospecting/cohorts/${id}`, cookie, { method: "PUT", body });
const detail = async (W: string, id: string, cursor?: string) => (await (await call(`/api/w/${W}/prospecting/cohorts/${id}${cursor ? `?cursor=${cursor}` : ""}`, owner)).json()) as Detail;
async function saved(W: string, filter: unknown, name = "cohort") {
  const r = await save(W, { name, filter });
  expect(r.status).toBe(200);
  return (await r.json()) as Cohort;
}
const emails = async (W: string, filter: unknown) => (await detail(W, (await saved(W, filter)).id)).members.map((m) => m.email).sort();

test("the cohort filter knows exactly the plugin SDK's verification results", () => {
  expect([...VERIFICATION_RESULTS]).toEqual([...SDK_RESULTS]);
});

test("a cohort is saved, read, listed and changed, and says who made it", async () => {
  const W = await newWorkspace();
  const made = await saved(W, { countries: ["gb"], verification: ["deliverable"] }, " UK, verified ");
  expect(made).toMatchObject({ name: "UK, verified", createdBy: U, filter: { signals: [], countries: ["GB"], kinds: [], sources: [], verification: ["deliverable"], runs: [] } });
  expect(await detail(W, made.id)).toMatchObject({ ...made, count: 0, members: [], next: null });

  const changed = await put(W, made.id, { name: "Anywhere", filter: { kinds: ["named"] } });
  expect(changed.status).toBe(200);
  expect(await changed.json()).toMatchObject({ id: made.id, name: "Anywhere", createdBy: U, filter: { kinds: ["named"], countries: [] } });
  const listed = (await (await call(`/api/w/${W}/prospecting/cohorts`, owner)).json()) as { cohorts: Cohort[] };
  expect(listed.cohorts.map((x) => [x.id, x.name])).toEqual([[made.id, "Anywhere"]]);
});

test("a bad filter or an unknown cohort is refused by name", async () => {
  const W = await newWorkspace();
  expect(await (await save(W, { name: "x", filter: { kinds: ["generic"] } })).json()).toEqual({ error: "unknown_value", field: "kinds", value: "generic" });
  expect(await (await save(W, { name: "x", filter: { country: ["GB"] } })).json()).toEqual({ error: "unknown_field", field: "country" });
  expect(await (await save(W, { name: "x", filter: ["hiring"] })).json()).toEqual({ error: "not_an_object" });
  expect((await save(W, { name: " ", filter: {} })).status).toBe(400);
  const made = await saved(W, {});
  const refused = await put(W, made.id, { name: "x", filter: { verification: ["safe"] } });
  expect([refused.status, await refused.json()]).toEqual([400, { error: "unknown_value", field: "verification", value: "safe" }]);

  const missing = crypto.randomUUID();
  expect((await call(`/api/w/${W}/prospecting/cohorts/${missing}`, owner)).status).toBe(404);
  expect((await put(W, missing, { name: "x", filter: {} })).status).toBe(404);
});

test("each filter field narrows who matches, and a member carries its evidence", async () => {
  const W = await newWorkspace();
  const firm = await seed(W, "hiring.test", {
    country: "GB",
    signals: ["hiring"],
    addresses: [
      { email: "jane.doe@hiring.test", kind: "named", source: "guessed", verification: "deliverable" },
      { email: "sales@hiring.test", verification: "catch_all" },
    ],
  });
  await seed(W, "blog.test", { country: "US", signals: ["stale_blog"], addresses: [{ email: "ops@blog.test", verification: "other" }] });
  await seed(W, "nowhere.test", { country: null, addresses: [{ email: "hi@nowhere.test" }] });

  expect(await emails(W, {})).toEqual(["hi@nowhere.test", "jane.doe@hiring.test", "ops@blog.test", "sales@hiring.test"]);
  expect(await emails(W, { signals: ["hiring"] })).toEqual(["jane.doe@hiring.test", "sales@hiring.test"]);
  expect(await emails(W, { signals: ["hiring", "stale_blog"] })).toEqual(["jane.doe@hiring.test", "ops@blog.test", "sales@hiring.test"]);
  expect(await emails(W, { countries: ["US"] })).toEqual(["ops@blog.test"]);
  expect(await emails(W, { kinds: ["named"] })).toEqual(["jane.doe@hiring.test"]);
  expect(await emails(W, { kinds: ["function"] })).toEqual(["hi@nowhere.test", "ops@blog.test", "sales@hiring.test"]);
  expect(await emails(W, { sources: ["guessed"] })).toEqual(["jane.doe@hiring.test"]);
  expect(await emails(W, { verification: ["deliverable", "other"] })).toEqual(["jane.doe@hiring.test", "ops@blog.test"]);
  expect(await emails(W, { signals: ["hiring"], verification: ["catch_all"] })).toEqual(["sales@hiring.test"]);

  const [jane] = (await detail(W, (await saved(W, { sources: ["guessed"] })).id)).members;
  expect(jane).toEqual({
    addressId: expect.any(String),
    email: "jane.doe@hiring.test",
    kind: "named",
    name: "Jane Doe",
    role: "Partner",
    source: "guessed",
    pattern: "first.last",
    verificationResult: "deliverable",
    verifiedAt: READ_AT.toISOString(),
    company: { id: firm.id, domain: "hiring.test", name: null, country: "GB" },
    evidence: { pageUrl: "https://hiring.test/team", readAt: READ_AT.toISOString(), snapshotId: firm.snapshotId },
  });
});

test("the count rises as companies are accepted; left-out, shared and rejected addresses never count", async () => {
  const W = await newWorkspace();
  const cohort = await saved(W, { signals: ["hiring"] });
  await seed(W, "kept.test", {
    signals: ["hiring"],
    addresses: [{ email: "sales@kept.test" }, { email: "info@kept.test", kind: "generic" }, { email: "x@kept.test", kind: "unknown" }, { email: "old@kept.test", leftOut: "not_kept" }],
  });
  await seed(W, "rejected.test", { state: "rejected", signals: ["hiring"], addresses: [{ email: "sales@rejected.test" }] });
  const waiting = await seed(W, "waiting.test", { state: "in_review", signals: ["hiring"], addresses: [{ email: "sales@waiting.test" }, { email: "ops@waiting.test" }] });
  expect(await detail(W, cohort.id)).toMatchObject({ count: 1, members: [{ email: "sales@kept.test" }] });

  await q(W, "update prospect_companies set state = 'accepted' where id = $1", [waiting.id]);
  const after = await detail(W, cohort.id);
  expect(after.count).toBe(3);
  expect(after.members.map((m) => m.email).sort()).toEqual(["ops@waiting.test", "sales@kept.test", "sales@waiting.test"]);
});

test("a filter's count before saving matches the saved cohort's, saves nothing, and refuses a bad filter by name", async () => {
  const W = await newWorkspace();
  await seed(W, "counted.test", { signals: ["hiring"], addresses: [{ email: "sales@counted.test" }, { email: "ops@counted.test" }] });
  await seed(W, "quiet.test", { addresses: [{ email: "sales@quiet.test" }] });
  const count = (filter: unknown) => call(`/api/w/${W}/prospecting/cohorts/count`, owner, { method: "POST", body: { filter } });
  expect(await (await count({ signals: ["hiring"] })).json()).toEqual({ count: 2 });
  expect(await (await count({})).json()).toEqual({ count: 3 });
  expect(await (await count({ kinds: ["generic"] })).json()).toEqual({ error: "unknown_value", field: "kinds", value: "generic" });
  expect((await (await call(`/api/w/${W}/prospecting/cohorts`, owner)).json()).cohorts).toEqual([]);
  expect((await detail(W, (await saved(W, { signals: ["hiring"] })).id)).count).toBe(2);
});

test("members come a page at a time", async () => {
  const W = await newWorkspace();
  await seed(W, "big.test", { addresses: Array.from({ length: 150 }, (_, i) => ({ email: `team${i}@big.test` })) });
  const cohort = await saved(W, {});
  const first = await detail(W, cohort.id);
  expect(first.count).toBe(150);
  expect(first.members).toHaveLength(100);
  expect(first.next).toBe(first.members[99]!.addressId);
  const second = await detail(W, cohort.id, first.next!);
  expect(second.members).toHaveLength(50);
  expect(second.next).toBeNull();
  expect(new Set([...first.members, ...second.members].map((m) => m.email)).size).toBe(150);
});

test("anyone in the Workspace reads, a contributor or above saves, and another Workspace gets 404", async () => {
  const W = await newWorkspace();
  await seed(W, "mine.test", { addresses: [{ email: "sales@mine.test" }] });
  const cohort = await saved(W, {});
  const roles = {
    admin: (await addMember(owner, W, "admin")).cookie,
    marketer: (await addMember(owner, W, "marketer")).cookie,
    contributor: (await addMember(owner, W, "contributor")).cookie,
    viewer: (await addMember(owner, W, "viewer")).cookie,
  };
  for (const cookie of Object.values(roles)) {
    expect((await call(`/api/w/${W}/prospecting/cohorts`, cookie)).status).toBe(200);
    expect((await call(`/api/w/${W}/prospecting/cohorts/${cohort.id}`, cookie)).status).toBe(200);
  }
  for (const cookie of [roles.admin, roles.marketer, roles.contributor]) {
    expect((await save(W, { name: "x", filter: {} }, cookie)).status).toBe(200);
    expect((await put(W, cohort.id, { name: "y", filter: {} }, cookie)).status).toBe(200);
  }
  expect((await save(W, { name: "x", filter: {} }, roles.viewer)).status).toBe(403);
  expect((await put(W, cohort.id, { name: "y", filter: {} }, roles.viewer)).status).toBe(403);

  const stranger = await signIn();
  const theirs = (await createOrg(stranger)).workspace.id;
  expect((await call(`/api/w/${W}/prospecting/cohorts`, stranger)).status).toBe(404);
  expect((await call(`/api/w/${W}/prospecting/cohorts/${cohort.id}`, stranger)).status).toBe(404);
  expect((await save(W, { name: "x", filter: {} }, stranger)).status).toBe(404);
  expect((await put(W, cohort.id, { name: "x", filter: {} }, stranger)).status).toBe(404);
  // Their own Workspace can't reach this cohort or its members either.
  expect((await call(`/api/w/${theirs}/prospecting/cohorts/${cohort.id}`, stranger)).status).toBe(404);
  expect((await put(theirs, cohort.id, { name: "x", filter: {} }, stranger)).status).toBe(404);
  expect(await (await call(`/api/w/${theirs}/prospecting/cohorts`, stranger)).json()).toEqual({ cohorts: [] });
  expect(await createCohorts().cohortMembers(theirs, cohort.id)).toBeNull();
  expect((await createCohorts().cohortMembers(W, cohort.id))?.members.map((m) => m.email)).toEqual(["sales@mine.test"]);
});

test("a cohort can pick the companies a search found, and Signals read recently enough", async () => {
  const W = await newWorkspace();
  const first = await seed(W, "first.test", { signals: ["hiring"], signalDaysAgo: 10, addresses: [{ email: "sales@first.test", verification: "deliverable" }] });
  await seed(W, "same-search.test", { runId: first.runId, signals: ["stale_blog"], signalDaysAgo: 90, addresses: [{ email: "ops@same-search.test" }] });
  const other = await seed(W, "other.test", { signals: ["hiring"], signalDaysAgo: 61, addresses: [{ email: "sales@other.test" }] });

  expect(await emails(W, { runs: [first.runId] })).toEqual(["ops@same-search.test", "sales@first.test"]);
  expect(await emails(W, { runs: [first.runId, other.runId] })).toEqual(["ops@same-search.test", "sales@first.test", "sales@other.test"]);
  expect(await emails(W, { runs: [crypto.randomUUID()] })).toEqual([]);
  expect(await emails(W, { signals: ["hiring"], signalMaxAgeDays: 60 })).toEqual(["sales@first.test"]);
  expect(await emails(W, { signals: ["hiring"], signalMaxAgeDays: 61 })).toEqual(["sales@first.test", "sales@other.test"]);
  // An age with no Signal type takes any Signal read recently enough.
  expect(await emails(W, { signalMaxAgeDays: 89 })).toEqual(["sales@first.test", "sales@other.test"]);
  expect(await emails(W, { runs: [first.runId], signalMaxAgeDays: 30 })).toEqual(["sales@first.test"]);

  const count = async (filter: unknown) => (await (await call(`/api/w/${W}/prospecting/cohorts/count`, owner, { method: "POST", body: { filter } })).json()) as unknown;
  expect(await count({ runs: [first.runId], signalMaxAgeDays: 30 })).toEqual({ count: 1 });
  expect(await count({ signalMaxAgeDays: 0 })).toEqual({ error: "unknown_value", field: "signalMaxAgeDays", value: 0 });
  expect(await count({ runs: ["not-a-search"] })).toEqual({ error: "unknown_value", field: "runs", value: "not-a-search" });

  const saved60 = await saved(W, { runs: [first.runId.toUpperCase()], signalMaxAgeDays: 60 });
  expect(saved60.filter).toEqual({ signals: [], countries: [], kinds: [], sources: [], verification: [], runs: [first.runId], signalMaxAgeDays: 60 });
  // One address checked deliverable, the other never checked; nothing was handed to a Campaign yet.
  expect(await detail(W, saved60.id)).toMatchObject({ count: 1, deliverable: 1, inCampaign: 0, usedBy: [] });
  expect(await detail(W, (await saved(W, { runs: [first.runId] })).id)).toMatchObject({ count: 2, deliverable: 1 });
  expect(await detail(W, (await saved(W, { verification: ["other"] })).id)).toMatchObject({ deliverable: 0 });
});

test("a cohort stored before searches existed in the filter still reads, counts and lists", async () => {
  const W = await newWorkspace();
  await seed(W, "old.test", { signals: ["hiring"], addresses: [{ email: "sales@old.test" }] });
  const cohort = await saved(W, { signals: ["hiring"] });
  await q(W, `update prospect_cohorts set filter = '{"signals":["hiring"],"countries":[],"kinds":[],"sources":[],"verification":[]}' where id = $1`, [cohort.id]);
  expect(await detail(W, cohort.id)).toMatchObject({ count: 1, filter: { signals: ["hiring"], runs: [] }, members: [{ email: "sales@old.test" }] });
  const listed = (await (await call(`/api/w/${W}/prospecting/cohorts`, owner)).json()) as { cohorts: Cohort[] };
  expect(listed.cohorts[0]!.filter).toEqual({ signals: ["hiring"], countries: [], kinds: [], sources: [], verification: [], runs: [] });
  expect((await createCohorts().cohortMembers(W, cohort.id))?.members.map((m) => m.email)).toEqual(["sales@old.test"]);
});
