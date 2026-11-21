// SPDX-License-Identifier: AGPL-3.0-only
// Verification of an accepted company and the guesses it makes, on a real database with a fake
// verification vendor. No vendor is ever called here.
import type { VerifyAddressOutput } from "@direx/plugin-sdk";
import { afterAll, beforeAll, expect, test } from "vitest";
import { appClient, ownerClient } from "../../../../../test/db";
import { guessesFor } from "./domain/guesses";
import { testIdentity } from "./fixtures/support";
import { createVerifier, VERIFIED_FOR_DAYS, verifyThrough, type VerifyAddress } from "./index";

const NOW = new Date("2026-11-02T12:00:00Z");
const PRICE = 500;
const { call, signIn, createOrg } = testIdentity();
const owner = await signIn();
const W = (await createOrg(owner)).workspace.id;
const U = ((await (await call("/api/me", owner)).json()) as { user: { id: string } }).user.id;
let c: Awaited<ReturnType<typeof appClient>>;

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
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

beforeAll(async () => {
  c = await appClient();
});
afterAll(() => c.end());

/** A vendor that answers each address from a script, by default deliverable, and counts its calls. */
function fakeVendor(answers: Record<string, string[]> = {}) {
  const calls: string[] = [];
  const verify: VerifyAddress = async (_w, email) => {
    calls.push(email);
    const result = (answers[email]?.shift() ?? "deliverable") as VerifyAddressOutput["result"];
    // Like the vendor, an unknown answer costs nothing.
    return { result, vendorStatus: result, credits: result === "unknown" ? 0 : 1, costMicros: result === "unknown" ? 0 : PRICE };
  };
  return { calls, verify };
}
const mailHost = async () => [{ exchange: "mx.example.net" }];
const verifier = (verify: VerifyAddress, at = NOW) => createVerifier({ verify, now: () => at, resolveMx: mailHost, log: () => undefined });

type Seeded = { addresses?: { email: string; name?: string; leftOut?: string }[]; people?: [string, string][]; country?: string | null; state?: string; page?: string };
/** An accepted company as review leaves it: one page, its published addresses and the people named on it. */
async function seed(domain: string, s: Seeded = {}) {
  const [run] = await q<{ id: string }>(
    `insert into prospect_runs (workspace_id, source, company_limit, confirmed_micros, confirmed_by, created_at, updated_at) values ($1, 'pasted', 10, 0, $2, now(), now()) returning id`,
    [W, U],
  );
  const [company] = await q<{ id: string }>(
    `insert into prospect_companies (workspace_id, domain, website, country, first_run_id, read_status, names_status, state, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'read', 'done', $6, now(), now()) returning id`,
    [W, domain, `https://${domain}/`, s.country === undefined ? "GB" : s.country, run!.id, s.state ?? "accepted"],
  );
  const id = company!.id;
  const [page] = await q<{ id: string }>(`insert into prospect_snapshots (workspace_id, company_id, page_url, digest, text, read_at) values ($1, $2, $3, 'd', $4, $5) returning id`, [
    W,
    id,
    `https://${domain}/team`,
    s.page ?? "Our team: Jane Doe, Partner. Ana Ruiz, Director. Bo Li, Manager.",
    NOW,
  ]);
  for (const a of s.addresses ?? []) {
    await q(
      `insert into prospect_addresses (workspace_id, company_id, email, kind, source, name, snapshot_id, read_at, notice_found, left_out_reason, created_at)
       values ($1, $2, $3, $4, 'published', $5, $6, $7, false, $8, now())`,
      [W, id, a.email, a.name ? "named" : "function", a.name ?? null, page!.id, NOW, a.leftOut ?? null],
    );
  }
  for (const [first, last] of s.people ?? []) {
    await q(`insert into prospect_people (workspace_id, company_id, first, last, role, created_at) values ($1, $2, $3, $4, 'Director', now())`, [W, id, first, last]);
  }
  return { id, runId: run!.id, job: { workspaceId: W, companyId: id } };
}

type Row = { email: string; source: string; pattern: string | null; kind: string; name: string | null; role: string | null; left_out_reason: string | null; verification_result: string | null; verified_at: Date | null };
const rows = (companyId: string) =>
  q<Row>("select email, source, pattern, kind, name, role, left_out_reason, verification_result, verified_at from prospect_addresses where company_id = $1 order by email", [companyId]);
const results = async (companyId: string) => Object.fromEntries((await rows(companyId)).map((r) => [r.email.split("@")[0], [r.verification_result, r.left_out_reason]]));
const cost = async (runId: string) => Number((await q<{ v: string }>("select verify_cost_micros as v from prospect_runs where id = $1", [runId]))[0]!.v);

test("kept published addresses are checked with their time and cost; one not kept isn't", async () => {
  const firm = await seed("published.test", { addresses: [{ email: "jane.doe@published.test", name: "Jane Doe" }, { email: "sales@published.test" }, { email: "info@published.test", leftOut: "generic_address" }] });
  const vendor = fakeVendor({ "sales@published.test": ["catch_all"] });
  expect(await verifier(vendor.verify).verifyCompany(firm.job)).toEqual({ status: "done", checked: 2, guessesKept: 0 });
  expect(vendor.calls.sort()).toEqual(["jane.doe@published.test", "sales@published.test"]);
  expect(await results(firm.id)).toEqual({ "jane.doe": ["deliverable", null], sales: ["catch_all", null], info: [null, "generic_address"] });
  expect((await rows(firm.id)).filter((r) => r.verification_result).map((r) => r.verified_at!.toISOString())).toEqual([NOW.toISOString(), NOW.toISOString()]);
  expect(await cost(firm.runId)).toBe(2 * PRICE);
});

test("an unknown is checked once more, and only once", async () => {
  const firm = await seed("unknown.test", { addresses: [{ email: "sales@unknown.test" }, { email: "hello@unknown.test" }] });
  const vendor = fakeVendor({ "sales@unknown.test": ["unknown", "deliverable"], "hello@unknown.test": ["unknown", "unknown", "deliverable"] });
  await verifier(vendor.verify).verifyCompany(firm.job);
  expect(vendor.calls.filter((e) => e.startsWith("sales@"))).toHaveLength(2);
  expect(vendor.calls.filter((e) => e.startsWith("hello@"))).toHaveLength(2);
  expect(await results(firm.id)).toEqual({ sales: ["deliverable", null], hello: ["unknown", null] });
  expect(await cost(firm.runId)).toBe(PRICE);
});

test("a hold stops queued verification and is checked again before retrying an unknown", async () => {
  const email = "sales@held.test";
  const firm = await seed("held.test", { addresses: [{ email }] });
  const db = await ownerClient();
  const hold = () => db.query("select system.set_operator_hold('workspace', $1, 'test', 'cli:test')", [W]);
  const lift = () => db.query("select system.lift_operator_hold('workspace', $1, 'cli:test')", [W]);
  const vendor = fakeVendor({ [email]: ["unknown", "deliverable"] });
  try {
    await hold();
    expect(await verifier(vendor.verify).verifyCompany(firm.job)).toEqual({ status: "refused", checked: 0, guessesKept: 0 });
    expect(vendor.calls).toEqual([]);
    await lift();

    const interrupted = verifier(async (ws, address) => {
      const answer = await vendor.verify(ws, address);
      await hold();
      return answer;
    });
    expect(await interrupted.verifyCompany(firm.job)).toEqual({ status: "refused", checked: 0, guessesKept: 0 });
    expect(vendor.calls).toEqual([email]);
    expect(await cost(firm.runId)).toBe(0);
    expect(await results(firm.id)).toEqual({ sales: [null, null] });

    await lift();
    expect(await verifier(vendor.verify).verifyCompany(firm.job)).toEqual({ status: "done", checked: 1, guessesKept: 0 });
    expect(vendor.calls).toEqual([email, email]);
    expect(await cost(firm.runId)).toBe(PRICE);
  } finally {
    await lift().finally(() => db.end());
  }
});

test("first@ invalid, then first.last@ deliverable is kept with its pattern; a person with a published address gets no guess", async () => {
  const firm = await seed("guess.test", { addresses: [{ email: "jane.doe@guess.test", name: "Jane Doe", leftOut: "not_kept" }], people: [["Jane", "Doe"], ["Ana", "Ruiz"]] });
  const vendor = fakeVendor({ "ana@guess.test": ["invalid"] });
  expect(await verifier(vendor.verify).verifyCompany(firm.job)).toEqual({ status: "done", checked: 2, guessesKept: 1 });
  expect(vendor.calls).toEqual(["ana@guess.test", "ana.ruiz@guess.test"]);
  const byEmail = Object.fromEntries((await rows(firm.id)).map((r) => [r.email, r]));
  expect(byEmail["ana@guess.test"]).toMatchObject({ source: "guessed", pattern: "first", verification_result: "invalid", left_out_reason: "not_deliverable" });
  expect(byEmail["ana.ruiz@guess.test"]).toMatchObject({ source: "guessed", pattern: "first.last", kind: "named", name: "Ana Ruiz", role: "Director", verification_result: "deliverable", left_out_reason: null });
  expect(byEmail["jane@guess.test"]).toBeUndefined();
  expect(await cost(firm.runId)).toBe(2 * PRICE);
});

test("the first catch-all ends guessing at the domain, also when a published address found it", async () => {
  const firm = await seed("catchall.test", { people: [["Ana", "Ruiz"], ["Bo", "Li"]] });
  const vendor = fakeVendor({ "ana@catchall.test": ["catch_all"] });
  await verifier(vendor.verify).verifyCompany(firm.job);
  expect(vendor.calls).toEqual(["ana@catchall.test"]);
  expect(await results(firm.id)).toEqual({ ana: ["catch_all", "not_deliverable"] });

  const published = await seed("catchall2.test", { addresses: [{ email: "sales@catchall2.test" }], people: [["Ana", "Ruiz"]] });
  const second = fakeVendor({ "sales@catchall2.test": ["catch_all"] });
  await verifier(second.verify).verifyCompany(published.job);
  expect(second.calls).toEqual(["sales@catchall2.test"]);
});

test("an unknown ends guessing for that person only", async () => {
  const firm = await seed("personunknown.test", { people: [["Ana", "Ruiz"], ["Bo", "Li"]] });
  const vendor = fakeVendor({ "ana@personunknown.test": ["unknown", "unknown"], "bo@personunknown.test": ["invalid"] });
  expect(await verifier(vendor.verify).verifyCompany(firm.job)).toMatchObject({ guessesKept: 1 });
  expect(vendor.calls).toEqual(["ana@personunknown.test", "ana@personunknown.test", "bo@personunknown.test", "bo.li@personunknown.test"]);
  expect(await results(firm.id)).toEqual({ ana: ["unknown", "not_deliverable"], bo: ["invalid", "not_deliverable"], "bo.li": ["deliverable", null] });
});

test("no one in Canada, or at a site with a do-not-email notice, is guessed for, and the row says why", async () => {
  const firm = await seed("canada.test", { country: "CA", addresses: [{ email: "sales@canada.test" }], people: [["Ana", "Ruiz"]] });
  const vendor = fakeVendor();
  expect(await verifier(vendor.verify).verifyCompany(firm.job)).toEqual({ status: "done", checked: 1, guessesKept: 0 });
  expect(vendor.calls).toEqual(["sales@canada.test"]);
  expect(await results(firm.id)).toEqual({ sales: ["deliverable", null], ana: [null, "country_ca"] });

  const notice = await seed("notice.test", { people: [["Ana", "Ruiz"]], page: "Ana Ruiz, Director. Please do not send us unsolicited email." });
  const second = fakeVendor();
  await verifier(second.verify).verifyCompany(notice.job);
  expect(second.calls).toEqual([]);
  expect(await results(notice.id)).toEqual({ ana: [null, "do_not_email_notice"] });
});

test("with no verification connected, kept addresses are unknown and nothing is guessed", async () => {
  const firm = await seed("noconnection.test", { addresses: [{ email: "sales@noconnection.test" }], people: [["Ana", "Ruiz"]] });
  const logged: string[] = [];
  const v = createVerifier({ verify: async () => null, now: () => NOW, resolveMx: mailHost, log: (l) => logged.push(l) });
  expect(await v.verifyCompany(firm.job)).toEqual({ status: "not_connected", checked: 1, guessesKept: 0 });
  expect(await results(firm.id)).toEqual({ sales: ["unknown", null] });
  expect(logged.join()).toContain("no verification connected");
  expect(await cost(firm.runId)).toBe(0);
});

/** A vendor that refuses every check, as Reoon does with no checks left. */
const refusing: VerifyAddress = async (_w, email) => Promise.reject(new Error(`${email} refused`));

test("a refused check stores nothing, guesses nothing, and is logged without the address", async () => {
  const firm = await seed("failing.test", { addresses: [{ email: "sales@failing.test" }, { email: "team@failing.test" }], people: [["Ana", "Ruiz"]] });
  const logged: string[] = [];
  const v = createVerifier({ verify: refusing, now: () => NOW, resolveMx: mailHost, log: (l) => logged.push(l) });
  expect(await v.verifyCompany(firm.job)).toEqual({ status: "refused", checked: 0, guessesKept: 0 });
  expect(await results(firm.id)).toEqual({ sales: [null, null], team: [null, null] });
  expect(logged.join()).not.toContain("sales@");
});

test("a refusal mid-guess keeps the answers before it, and a later run finishes the company", async () => {
  const firm = await seed("midguess.test", { addresses: [{ email: "sales@midguess.test" }], people: [["Ana", "Ruiz"]] });
  let left = 1;
  const vendor = fakeVendor();
  const runsOut: VerifyAddress = async (w, email) => (left-- > 0 ? vendor.verify(w, email) : refusing(w, email));
  expect(await verifier(runsOut).verifyCompany(firm.job)).toEqual({ status: "refused", checked: 1, guessesKept: 0 });
  expect(await results(firm.id)).toEqual({ sales: ["deliverable", null] });

  vendor.calls.length = 0;
  expect(await verifier(vendor.verify).verifyCompany(firm.job)).toEqual({ status: "done", checked: 1, guessesKept: 1 });
  expect(vendor.calls).toEqual(["ana@midguess.test"]);
  expect(await results(firm.id)).toEqual({ sales: ["deliverable", null], ana: ["deliverable", null] });
});

test("an unknown stored before is asked again: a published address, and a guess that is then kept", async () => {
  const firm = await seed("again.test", { addresses: [{ email: "sales@again.test" }], people: [["Ana", "Ruiz"]] });
  await verifier(fakeVendor({ "sales@again.test": ["unknown", "unknown"], "ana@again.test": ["unknown", "unknown"] }).verify).verifyCompany(firm.job);
  expect(await results(firm.id)).toEqual({ sales: ["unknown", null], ana: ["unknown", "not_deliverable"] });

  const later = fakeVendor();
  expect(await verifier(later.verify).verifyCompany(firm.job)).toEqual({ status: "done", checked: 2, guessesKept: 1 });
  expect(later.calls).toEqual(["sales@again.test", "ana@again.test"]);
  expect(await results(firm.id)).toEqual({ sales: ["deliverable", null], ana: ["deliverable", null] });
});

test("before hand-over, a refused check leaves the address out of the answer and unchanged", async () => {
  const firm = await seed("handrefused.test", { addresses: [{ email: "sales@handrefused.test" }] });
  const id = (await q<{ id: string }>("select id from prospect_addresses where company_id = $1", [firm.id]))[0]!.id;
  expect((await verifier(refusing).freshResults(W, [id])).size).toBe(0);
  expect(await results(firm.id)).toEqual({ sales: [null, null] });
});

test("an address with no mail record is invalid without paying for a check", async () => {
  const firm = await seed("nomx.test", { addresses: [{ email: "sales@nomx.test" }] });
  const vendor = fakeVendor();
  await createVerifier({ verify: vendor.verify, now: () => NOW, resolveMx: async () => [] }).verifyCompany(firm.job);
  expect(vendor.calls).toEqual([]);
  expect(await results(firm.id)).toEqual({ sales: ["invalid", null] });
});

test("nothing is checked for a rejected company, or one still in review", async () => {
  for (const state of ["rejected", "in_review"]) {
    const firm = await seed(`${state.replace("_", "")}.test`, { state, addresses: [{ email: `sales@${state.replace("_", "")}.test` }], people: [["Ana", "Ruiz"]] });
    const vendor = fakeVendor();
    expect(await verifier(vendor.verify).verifyCompany(firm.job)).toEqual({ status: "not_accepted", checked: 0, guessesKept: 0 });
    expect(vendor.calls).toEqual([]);
    expect(await results(firm.id)).toEqual({ sales: [null, null] });
  }
});

test("a retried job pays for nothing twice and adds no rows; only an unknown is asked again", async () => {
  const firm = await seed("retry.test", { addresses: [{ email: "sales@retry.test" }], people: [["Ana", "Ruiz"], ["Bo", "Li"]] });
  const vendor = fakeVendor({ "ana@retry.test": ["invalid"], "bo@retry.test": ["unknown", "unknown", "unknown", "unknown"] });
  const v = verifier(vendor.verify);
  await v.verifyCompany(firm.job);
  const before = { calls: vendor.calls.length, rows: await rows(firm.id), cost: await cost(firm.runId) };
  expect(await v.verifyCompany(firm.job)).toEqual({ status: "done", checked: 1, guessesKept: 0 });
  expect(vendor.calls.slice(before.calls)).toEqual(["bo@retry.test", "bo@retry.test"]);
  expect((await rows(firm.id)).map((r) => [r.email, r.verification_result, r.left_out_reason])).toEqual(before.rows.map((r) => [r.email, r.verification_result, r.left_out_reason]));
  expect(await cost(firm.runId)).toBe(before.cost);
});

test("before hand-over, a result older than 30 days or unknown is checked again; a fresh one and a left-out one aren't", async () => {
  const firm = await seed("fresh.test", { addresses: [{ email: "sales@fresh.test" }, { email: "hello@fresh.test" }, { email: "info@fresh.test", leftOut: "generic_address" }] });
  const vendor = fakeVendor({ "hello@fresh.test": ["unknown", "unknown"] });
  await verifier(vendor.verify).verifyCompany(firm.job);
  const ids = Object.fromEntries((await q<{ id: string; email: string }>("select id, email from prospect_addresses where company_id = $1", [firm.id])).map((r) => [r.email.split("@")[0]!, r.id]));
  const all = Object.values(ids);

  vendor.calls.length = 0;
  const soon = await verifier(vendor.verify, new Date(NOW.getTime() + 10 * 86_400_000)).freshResults(W, all);
  expect(vendor.calls).toEqual(["hello@fresh.test"]);
  expect(Object.fromEntries(soon)).toEqual({ [ids.sales!]: "deliverable", [ids.hello!]: "deliverable" });

  vendor.calls.length = 0;
  const late = new Date(NOW.getTime() + (VERIFIED_FOR_DAYS + 1) * 86_400_000);
  await verifier(fakeVendor({ "sales@fresh.test": ["invalid"] }).verify, late).freshResults(W, [ids.sales!]);
  expect(await results(firm.id)).toMatchObject({ sales: ["invalid", null] });
  expect((await rows(firm.id)).find((r) => r.email === "sales@fresh.test")!.verified_at!.toISOString()).toBe(late.toISOString());
});

test("the composition root's check uses the Workspace's credential and doesn't trust the plugin's answer", async () => {
  const seen: unknown[] = [];
  const query = async (...args: unknown[]) => {
    seen.push(args);
    return { result: "deliverable", vendorStatus: "safe", credits: 1, costMicros: 0 };
  };
  const verify = verifyThrough({ query, capability: "x/email.verify", credentialFor: async (w) => (w === W ? "cred-1" : null) });
  expect(await verify("other", "a@b.test")).toBeNull();
  expect(await verify(W, "a@b.test")).toEqual({ result: "deliverable", vendorStatus: "safe", credits: 1, costMicros: 0 });
  expect(seen).toEqual([[W, "x/email.verify", { email: "a@b.test" }, "cred-1"]]);
  const lying = verifyThrough({ query: async () => ({ result: "safe_to_send" }), capability: "x/email.verify", credentialFor: async () => "c" });
  await expect(lying(W, "a@b.test")).rejects.toThrow();
});

test("guesses are made from letters only, and first.last@ only with a last name", () => {
  expect(guessesFor("José", "Núñez-Ortega", "acme.test")).toEqual([
    { email: "jose@acme.test", pattern: "first" },
    { email: "jose.nunezortega@acme.test", pattern: "first.last" },
  ]);
  expect(guessesFor("Ana", "", "acme.test")).toEqual([{ email: "ana@acme.test", pattern: "first" }]);
  expect(guessesFor("李", "Li", "acme.test")).toEqual([]);
});
