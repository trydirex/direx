// SPDX-License-Identifier: AGPL-3.0-only
// Customers: a Person role stored in person_roles, and the import that adds only opted-in rows, with
// consent recorded as their basis. Through HTTP with real outreach, and the table as direx_app.
import { afterAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createFacts } from "../facts/index";
import { itemsApp } from "../items/fixtures/items";
import { createOutreach } from "../outreach/index";
import { createPlans } from "../plans/index";
import { campaignOnPlanCreated, campaignRoutes, createCampaigns } from "./index";

const { routes, call, signIn, createOrg, addMember, items } = await itemsApp();
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const noSend = () => {
  throw new Error("nothing is sent here");
};
const readBacks = new Map<string, () => Promise<void>>();
const outreach = createOutreach({ items: () => items, send: noSend, baseUrl: () => "http://direx.test", readBack: async (_ws, email) => readBacks.get(email)?.() });
const noDraft = async () => ({ ok: false as const, reason: "not_here" });
const campaigns = createCampaigns({ plans, facts, items: () => items, outreach: () => outreach, startDraft: () => noDraft });
routes.route("/", campaignRoutes({ campaigns: () => campaigns }));

const owner = await signIn();
const W = (await createOrg(owner)).workspace.id;
const viewer = (await addMember(owner, W, "viewer")).cookie;
const other = await signIn();
const V = (await createOrg(other)).workspace.id;
await outreach.saveIdentity(W, { senderName: "Acme", postalAddress: "1 Main St", senderCountry: "GB" });

type Import = { added: { personId: string; email: string }[]; updated: { personId: string; email: string }[]; skipped: { row: number; email?: string; reason: string }[] };
type Listed = { personId: string; email: string | null; name: string | null; company: string | null; basis: string | null; evidence: string | null; basisRecordedAt: string | null };
const importCsv = async (csv: string, cookie = owner, w = W) => {
  const r = await call(`/api/w/${w}/customers/import`, cookie, { method: "POST", body: { csv } });
  return { status: r.status, body: (await r.json()) as Import };
};
const list = async (cookie = owner, w = W) => ((await (await call(`/api/w/${w}/customers`, cookie)).json()) as { customers: Listed[] }).customers;
const address = () => `${crypto.randomUUID()}@acme.test`;
const HEAD = "name,email,company,opted_in,opted_in_on";

const c = await appClient();
afterAll(() => c.end());
const as = (w: string) => c.query("select set_config('app.workspace_id', $1, false)", [w]);

test("opted-in rows become Customers with consent as their basis; the rest are listed with a reason", async () => {
  const [yes, alsoYes, no, blank, suppressed] = [address(), address(), address(), address(), address()];
  await outreach.addSuppression(W, suppressed);
  const csv = [HEAD, `Sam Lee,${yes.toUpperCase()},Acme,Yes,2026-03-04`, `Kim,${alsoYes},,1,`, `Ann,${no},Acme,no,`, `Bo,${blank},,,`, `Cy,not-an-email,,yes,`, `Di,${suppressed},,true,`, `Ed,${address()},,yes,2026-02-30`, "only,two"].join("\n");
  const { status, body } = await importCsv(csv);
  expect(status).toBe(200);
  expect(body.added.map((a) => a.email)).toEqual([yes, alsoYes]);
  expect(body.updated).toEqual([]);
  expect(body.skipped).toEqual([
    { row: 3, email: no, reason: "no_opt_in" },
    { row: 4, email: blank, reason: "no_opt_in" },
    { row: 5, email: "not-an-email", reason: "invalid_email" },
    { row: 6, email: suppressed, reason: "suppressed" },
    { row: 7, email: expect.any(String), reason: "bad_opt_in_date" },
    { row: 8, reason: "wrong_column_count" },
  ]);

  const listed = await list();
  expect(listed.find((p) => p.email === yes)).toMatchObject({ personId: body.added[0]!.personId, name: "Sam Lee", company: "Acme", basis: "consent", evidence: "Customer import: opted in on 2026-03-04", basisRecordedAt: expect.any(String) });
  expect(listed.find((p) => p.email === alsoYes)).toMatchObject({ name: "Kim", company: null, evidence: "Customer import: opted in (no date given)" });
  expect(listed.map((p) => p.email)).not.toContain(no);
  // No country in the list, so the Workspace's own is recorded as a guess that says so.
  expect(await outreach.person(W, body.added[0]!.personId)).toMatchObject({ country: "GB", basis: "consent", confidence: "inferred" });
});

test("invalid opt-in dates are skipped and a later opted-in row is still imported", async () => {
  const dates = ["2026-13-01", "2026-00-15", "2026-01-32"];
  const invalid = dates.map(() => address());
  const valid = address();
  const csv = ["email,opted_in,opted_in_on", ...dates.map((date, i) => `${invalid[i]},yes,${date}`), `${valid},yes,2024-02-29`].join("\n");
  const { status, body } = await importCsv(csv);

  expect(status).toBe(200);
  expect(body.skipped).toEqual(invalid.map((email, i) => ({ row: i + 1, email, reason: "bad_opt_in_date" })));
  expect(body.added.map((row) => row.email)).toEqual([valid]);
});

test("concurrent imports of a new email return one Customer and reuse its Person", async () => {
  const email = address();
  // Hold both requests after their first lookup misses, before either can create a Person.
  const bothMissed = Promise.withResolvers<void>();
  let misses = 0;
  readBacks.set(email, async () => {
    if (++misses === 2) bothMissed.resolve();
    await bothMissed.promise;
  });
  try {
    const results = await Promise.all([importCsv(`email,opted_in\n${email},yes`), importCsv(`email,opted_in\n${email.toUpperCase()},yes`)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const added = results.flatMap((r) => r.body.added);
    const updated = results.flatMap((r) => r.body.updated);
    expect(added).toEqual([{ email, personId: expect.any(String) }]);
    expect(updated).toEqual(added);
    expect((await list()).filter((p) => p.email === email)).toEqual([expect.objectContaining({ ...added[0], basis: "consent" })]);
  } finally {
    readBacks.delete(email);
  }
});

test("re-importing the same list adds no one twice, and a later name changes what's stored", async () => {
  const a = address();
  const first = (await importCsv(`${HEAD}\nSam,${a},Acme,yes,2026-01-01`)).body;
  const again = (await importCsv(`${HEAD}\nSam,${a},Acme,yes,2026-01-01`)).body;
  expect(again.added).toEqual([]);
  expect(again.updated).toEqual(first.added);
  const renamed = (await importCsv(`${HEAD}\nSamuel,${a},,yes,2026-01-01`)).body;
  expect(renamed.updated).toEqual(first.added);
  expect((await list()).filter((p) => p.email === a)).toEqual([expect.objectContaining({ name: "Samuel", company: "Acme" })]);
});

test("an existing Person with another basis gets the opt-in recorded as consent, keeping their country", async () => {
  const a = address();
  await outreach.addPerson(W, { email: a, country: "US", basis: "legitimate_interest", evidence: "Met at a fair", entityType: "corporate", userId: (await me()).id });
  const { body } = await importCsv(`email,opted_in,country\n${a},yes,`);
  expect(body.added).toHaveLength(1);
  expect(await outreach.person(W, body.added[0]!.personId)).toMatchObject({ country: "US", basis: "consent", entityType: "corporate", confidence: "stated" });
});

test("a consent already on record is kept as it is", async () => {
  const a = address();
  await outreach.addPerson(W, { email: a, country: "DE", basis: "consent", evidence: "Signed up on the form", userId: (await me()).id });
  const { body } = await importCsv(`email,opted_in,opted_in_on\n${a},yes,2026-05-01`);
  expect((await list()).find((p) => p.personId === body.added[0]!.personId)).toMatchObject({ basis: "consent", evidence: "Signed up on the form" });
});

test("a row's own country is stated; with no country anywhere the row is left out", async () => {
  const a = address();
  const { body } = await importCsv(`email,opted_in,country\n${a},yes,fr\n${address()},yes,France`);
  expect(await outreach.person(W, body.added[0]!.personId)).toMatchObject({ country: "FR", confidence: "stated" });
  expect(body.skipped).toEqual([{ row: 2, email: expect.any(String), reason: "bad_country" }]);

  // V has no sender country set.
  const none = await importCsv(`email,opted_in\n${address()},yes`, other, V);
  expect(none.body.skipped).toEqual([{ row: 1, email: expect.any(String), reason: "no_country" }]);
});

test("a list with no email column or a broken quote is refused whole", async () => {
  expect(await importCsv("name,opted_in\nSam,yes")).toEqual({ status: 400, body: { error: "no_email_column" } });
  expect((await importCsv('email,opted_in\n"a@acme.test,yes')).status).toBe(400);
});

test("another Workspace sees none of W's Customers, a stranger gets 404, and a Viewer may list but not import", async () => {
  const a = address();
  await importCsv(`email,opted_in\n${a},yes`);
  expect((await list(other, V)).map((p) => p.email)).not.toContain(a);
  expect((await call(`/api/w/${W}/customers`, other)).status).toBe(404);
  expect((await importCsv(`email,opted_in\n${address()},yes`, other)).status).toBe(404);
  expect((await list(viewer)).map((p) => p.email)).toContain(a);
  expect((await importCsv(`email,opted_in\n${address()},yes`, viewer)).status).toBe(403);
});

async function me() {
  return ((await (await call("/api/me", owner)).json()) as { user: { id: string } }).user;
}

test("person_roles: one row per Person and role, only known roles, only the name and company change, and RLS hides other Workspaces", async () => {
  const { body } = await importCsv(`name,email,opted_in\nPat,${address()},yes`);
  const personId = body.added[0]!.personId;
  const userId = (await me()).id;
  await as(W);
  const insert = (role: string) => c.query("insert into person_roles (workspace_id, person_id, role, added_by, at) values ($1, $2, $3, $4, now())", [W, personId, role, userId]);
  await expect(insert("customer")).rejects.toThrow(/person_roles_pkey/);
  await expect(insert("candidate")).rejects.toThrow(/person_roles_role_check/);
  await expect(c.query("update person_roles set role = 'customer', at = now() where person_id = $1", [personId])).rejects.toThrow(/permission denied/);
  await expect(c.query("update person_roles set name = 'P' where person_id = $1", [personId])).resolves.toMatchObject({ rowCount: 1 });
  await expect(c.query("update person_roles set name = $2 where person_id = $1", [personId, "x".repeat(201)])).rejects.toThrow(/person_roles_name_check/);

  await as(V);
  expect((await c.query("select 1 from person_roles where person_id = $1", [personId])).rowCount).toBe(0);
  await expect(c.query("insert into person_roles (workspace_id, person_id, role, added_by, at) values ($1, $2, 'customer', $3, now())", [W, personId, userId])).rejects.toThrow(/row-level security/);
  // A role in V can't point at W's Person.
  await expect(c.query("insert into person_roles (workspace_id, person_id, role, added_by, at) values ($1, $2, 'customer', $3, now())", [V, personId, userId])).rejects.toThrow(/person_roles_person_fk/);

  await as(W);
  await expect(c.query("delete from person_roles where person_id = $1", [personId])).resolves.toMatchObject({ rowCount: 1 });
});
