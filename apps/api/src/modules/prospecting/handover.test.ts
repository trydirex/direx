// SPDX-License-Identifier: AGPL-3.0-only
// Handing a cohort to a Campaign over HTTP, on a real database with real plans, campaigns, outreach,
// items and ledger. The verification vendor is a fake that answers from a script; the job is run
// directly rather than through the queue, so a test can make a batch fail and run it again.
import type { VerifyAddressOutput } from "@direx/plugin-sdk";
import { afterAll, beforeAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createBoss } from "../../jobs/boss";
import { CONFLICT_KIND, campaignOnPlanApproved, campaignOnPlanCreated, campaignKinds, campaignRoutes, createCampaigns, type Campaigns } from "../campaigns/index";
import { createFacts, factKinds } from "../facts/index";
import { createOutreach } from "../outreach/index";
import { createPlans, planKinds, planRoutes } from "../plans/index";
import { actionIdOf, itemsApp, POST } from "./fixtures/support";
import { addressLabelsFor, createHandovers, createVerifier, HANDOVER_QUEUE, keptEligibility, prospectingRoutes, signalsFor, VERIFIED_FOR_DAYS, type VerifyAddress } from "./index";

const NOW = new Date("2026-11-02T12:00:00Z");
const DAY = 86_400_000;
const boss = createBoss();
await boss.start();
await boss.createQueue(HANDOVER_QUEUE);
afterAll(() => boss.stop({ graceful: false, close: true }));

const { routes, call, signIn, createOrg, addMember, items, ledger } = await itemsApp({ kinds: { ...factKinds(), ...planKinds({ onPlanApproved: campaignOnPlanApproved({ items: () => items }) }), ...campaignKinds() } });
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const noSend = () => {
  throw new Error("nothing is sent here");
};
const outreach = createOutreach({ items: () => items, send: noSend, baseUrl: () => "http://direx.test" });
const campaigns = createCampaigns({ plans, facts, items: () => items, outreach: () => outreach, startDraft: () => async () => ({ ok: false, reason: "not_here" }), keptEligibility });

/** A vendor that answers each address from a script, by default deliverable, and records what it was asked. */
const vendor = { calls: [] as string[], answers: {} as Record<string, string> };
const verify: VerifyAddress = async (_w, email) => {
  vendor.calls.push(email);
  const result = (vendor.answers[email] ?? "deliverable") as VerifyAddressOutput["result"];
  return { result, vendorStatus: result, credits: 1, costMicros: 0 };
};
const verifier = createVerifier({ verify, now: () => NOW, resolveMx: async () => [{ exchange: "mx.example.net" }], log: () => undefined });

/** The Campaign's entry, counting the rows of each call and failing the calls a test asks to fail. */
const calls: number[] = [];
const failing = { calls: new Set<number>() };
const counted: Pick<Campaigns, "addPeopleRows"> = {
  addPeopleRows: async (...a) => {
    calls.push(a[2].length);
    if (failing.calls.delete(calls.length)) throw new Error("the database went away");
    return campaigns.addPeopleRows(...a);
  },
};
const handovers = createHandovers({ boss, campaigns: () => counted, freshResults: verifier.freshResults, now: () => NOW, batchSize: 3 });

routes.route("/", planRoutes({ plans: () => plans, startDraft: async () => ({ ok: true, run: { id: crypto.randomUUID() } }) }));
routes.route("/", campaignRoutes({ campaigns: () => campaigns }));
routes.route("/", prospectingRoutes({ runs: () => { throw new Error("hand-over needs no runs"); }, handovers: () => handovers, terms: () => { throw new Error("hand-over needs no terms"); } }));

const owner = await signIn();
const U = ((await (await call("/api/me", owner)).json()) as { user: { id: string } }).user.id;
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

const send = (method: string, path: string, cookie: string, body?: unknown) => call(path, cookie, { method, ...(body !== undefined && { body }) });
const read = async <T>(path: string, cookie = owner) => (await (await call(path, cookie)).json()) as T;
type Waiting = { id: string; revision: number };
type Result = { addressId: string; email: string; status: string; reason: string | null; personId: string | null; conflictItemId: string | null; missing: string[] };
type HandoverView = { status: string; counts: Record<string, number>; results: Result[]; next: string | null };

/** A Workspace with an approved strategy, so it can make Campaigns, and everything a test does in it. */
async function world() {
  const W = (await createOrg(owner)).workspace.id;
  const url = (rest = "") => `/api/w/${W}${rest}`;
  const approve = (w: Waiting) => send("POST", url(`/items/${w.id}/approve`), owner, { revision: w.revision });
  const strategy = { schemaVersion: 1, whoFor: "Ops", personas: [], positioning: "Audit", channels: [{ key: "email", label: "Email", timing: "now", reason: "Read", basis: { kind: "assumption" } }], assumptions: [] };
  await send("PUT", url("/strategy/draft"), owner, { revision: 0, body: strategy });
  await send("POST", url("/strategy/submit"), owner, { revision: 1 });
  await approve((await read<{ waiting: Waiting }>(url("/strategy"))).waiting);

  async function newCampaign() {
    const { id } = (await (await send("POST", url("/plans"), owner, { title: "Q4" })).json()) as { id: string };
    const body = { schemaVersion: 1, goal: "4 meetings", audience: "Ops", startsOn: "2026-11-01", endsOn: "2026-11-30", steps: [{ key: "first", on: "2026-11-03", title: "First" }], measures: [{ key: "m", label: "M", target: "4", basis: { kind: "assumption" } }], budget: [], assumptions: [] };
    await send("PUT", url(`/plans/${id}/draft`), owner, { revision: 0, body });
    await send("POST", url(`/plans/${id}/submit`), owner, { revision: 1 });
    await approve((await read<{ waiting: Waiting }>(url(`/plans/${id}`))).waiting);
    return (await read<{ campaigns: { id: string; planId: string }[] }>(url("/campaigns"))).campaigns.find((x) => x.planId === id)!.id;
  }

  type Address = { email: string; source?: "published" | "guessed"; name?: string | null; verification?: string | null; verifiedDaysAgo?: number };
  /** An accepted company with one page and its kept addresses, as review and verification leave them. */
  async function seed(domain: string, addresses: Address[], country: string | null = "GB") {
    const [run] = await q<{ id: string }>(W, `insert into prospect_runs (workspace_id, source, company_limit, confirmed_micros, confirmed_by, created_at, updated_at) values ($1, 'pasted', 10, 0, $2, now(), now()) returning id`, [W, U]);
    const [company] = await q<{ id: string }>(
      W,
      `insert into prospect_companies (workspace_id, domain, website, name, country, first_run_id, read_status, names_status, state, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, 'read', 'done', 'accepted', now(), now()) returning id`,
      [W, domain, `https://${domain}/`, `${domain} Ltd`, country, run!.id],
    );
    const [page] = await q<{ id: string }>(W, `insert into prospect_snapshots (workspace_id, company_id, page_url, digest, text, read_at) values ($1, $2, $3, 'd', 'Our team', $4) returning id`, [
      W,
      company!.id,
      `https://${domain}/team`,
      new Date(NOW.getTime() - 5 * DAY),
    ]);
    for (const a of addresses) {
      const source = a.source ?? "published";
      const result = a.verification === undefined ? "deliverable" : a.verification;
      await q(
        W,
        `insert into prospect_addresses (workspace_id, company_id, email, kind, source, pattern, name, role, snapshot_id, read_at, notice_found, verification_result, verified_at, created_at)
         values ($1, $2, $3, 'named', $4, $5, $6, 'Partner', $7, $8, false, $9, $10, now())`,
        [W, company!.id, a.email, source, source === "guessed" ? "first" : null, a.name === undefined ? "Jane Doe" : a.name, page!.id, new Date(NOW.getTime() - 5 * DAY), result, result ? new Date(NOW.getTime() - (a.verifiedDaysAgo ?? 1) * DAY) : null],
      );
    }
    return { snapshotId: page!.id, runId: run!.id };
  }

  /** A cohort over the whole Workspace unless a filter is given: each test has its own, so it matches only what that test seeded. */
  async function cohort(filter: Record<string, unknown> = {}) {
    const r = await send("POST", url("/prospecting/cohorts"), owner, { name: "Everyone", filter });
    expect(r.status).toBe(200);
    return ((await r.json()) as { id: string }).id;
  }

  /** Queues a hand-over over HTTP, checks the job is on the queue, then works it here. */
  async function handOver(cohortId: string, campaignId: string) {
    const r = await send("POST", url(`/prospecting/cohorts/${cohortId}/add-to-campaign`), owner, { campaignId });
    expect(r.status).toBe(202);
    const { handoverId } = (await r.json()) as { handoverId: string };
    expect((await boss.findJobs(HANDOVER_QUEUE, { data: { handoverId } })).map((j) => j.data)).toEqual([{ workspaceId: W, handoverId }]);
    return handoverId;
  }
  const work = (handoverId: string) => handovers.run({ workspaceId: W, handoverId });
  const view = (handoverId: string, cursor?: string) => read<HandoverView>(url(`/prospecting/handovers/${handoverId}${cursor ? `?cursor=${cursor}` : ""}`));
  const byEmail = async (handoverId: string) => Object.fromEntries((await view(handoverId)).results.map((r) => [r.email, r]));
  const eligibility = async (email: string) => (await outreach.overview(W)).people.find((p) => p.email === email);

  return { W, url, newCampaign, seed, cohort, handOver, work, view, byEmail, eligibility };
}

test("published and guessed addresses go over with their basis, country and an evidence summary, and the Person is recorded here", async () => {
  const w = await world();
  const { snapshotId } = await w.seed("basis.test", [{ email: "jane@basis.test" }, { email: "bo@basis.test", source: "guessed", name: "Bo Li" }]);
  const campaignId = await w.newCampaign();
  const id = await w.handOver(await w.cohort(), campaignId);
  expect((await w.view(id)).status).toBe("running");
  vendor.calls.length = 0;
  await w.work(id);

  expect(vendor.calls).toEqual([]);
  const done = await w.view(id);
  expect(done).toMatchObject({ status: "done", counts: { added: 2, joined: 0, conflict: 0, leftOut: 0 }, next: null });
  expect(await w.eligibility("jane@basis.test")).toMatchObject({ country: "GB", basis: "published_address", entityType: "unknown", confidence: "inferred", warnings: ["entity_unknown", "country_inferred", "sender_country_missing"] });
  expect(await w.eligibility("bo@basis.test")).toMatchObject({ country: "GB", basis: "legitimate_interest", entityType: "unknown", confidence: "inferred" });

  const evidence = await q<{ email: string; evidence: string }>(w.W, "select k.value as email, e.evidence from person_eligibility e join person_keys k on k.person_id = e.person_id and k.kind = 'email'");
  const of = Object.fromEntries(evidence.map((e) => [e.email, e.evidence]));
  expect(of["jane@basis.test"]).toBe(`Address published on the company's site; verified deliverable on 2026-11-01; page read 2026-10-28T12:00:00.000Z, snapshot ${snapshotId}: https://basis.test/team`);
  expect(of["bo@basis.test"]).toMatch(/^Guessed address \(first@\) for a person named on the company's site; verified deliverable on 2026-11-01;/);

  const people = (await campaigns.people(w.W, campaignId)).people;
  expect(people.map((p) => [p.email, p.firstName, p.company, p.status]).sort()).toEqual([
    ["bo@basis.test", "Bo", "basis.test Ltd", "active"],
    ["jane@basis.test", "Jane", "basis.test Ltd", "active"],
  ]);
  const linked = await q<{ email: string; person_id: string }>(w.W, "select email, person_id from prospect_addresses order by email");
  expect(linked.map((l) => l.person_id).sort()).toEqual(done.results.map((r) => r.personId).sort());
});

test("a result older than 30 days or unknown is checked again first, and only deliverable goes over", async () => {
  const w = await world();
  await w.seed("fresh.test", [
    { email: "stale@fresh.test", verifiedDaysAgo: VERIFIED_FOR_DAYS + 5 },
    { email: "unknown@fresh.test", verification: "unknown" },
    { email: "catch@fresh.test", verification: "catch_all" },
    { email: "gone@fresh.test", verification: "invalid" },
  ]);
  vendor.answers["stale@fresh.test"] = "invalid";
  vendor.calls.length = 0;
  const id = await w.handOver(await w.cohort(), await w.newCampaign());
  await w.work(id);

  expect(vendor.calls.sort()).toEqual(["stale@fresh.test", "unknown@fresh.test"]);
  const r = await w.byEmail(id);
  expect(r["unknown@fresh.test"]).toMatchObject({ status: "added" });
  for (const e of ["stale@fresh.test", "catch@fresh.test", "gone@fresh.test"]) expect(r[e]).toMatchObject({ status: "left_out", reason: "not_deliverable", personId: null });
  // The summary names the check just made, not the old one.
  const [row] = await q<{ evidence: string }>(w.W, "select e.evidence from person_eligibility e join person_keys k on k.person_id = e.person_id where k.value = 'unknown@fresh.test'");
  expect(row!.evidence).toContain("verified deliverable on 2026-11-02");
});

test("a guess is never handed over for a company in Canada or a Person recorded in Canada; a published address is", async () => {
  const w = await world();
  await w.seed("maple.test", [{ email: "pub@maple.test" }, { email: "guess@maple.test", source: "guessed", verifiedDaysAgo: VERIFIED_FOR_DAYS + 5 }], "CA");
  await w.seed("abroad.test", [{ email: "moved@abroad.test", source: "guessed" }]);
  const known = await outreach.addPerson(w.W, { email: "moved@abroad.test", country: "CA", basis: "published_address", evidence: "Listed at a Toronto event", userId: U });
  expect(known.ok).toBe(true);
  vendor.calls.length = 0;
  const id = await w.handOver(await w.cohort(), await w.newCampaign());
  await w.work(id);

  // Nothing is paid for a guess that can't go over.
  expect(vendor.calls).toEqual([]);
  const r = await w.byEmail(id);
  expect(r["guess@maple.test"]).toMatchObject({ status: "left_out", reason: "guess_in_canada" });
  expect(r["moved@abroad.test"]).toMatchObject({ status: "left_out", reason: "guess_in_canada" });
  expect(r["pub@maple.test"]).toMatchObject({ status: "added" });
  expect(await w.eligibility("pub@maple.test")).toMatchObject({ country: "CA", basis: "published_address" });
  expect(await w.eligibility("moved@abroad.test")).toMatchObject({ country: "CA", basis: "published_address" });
});

test("an unknown country adds the Person with country missing, kept out of drafts, and the full record stays here", async () => {
  const w = await world();
  await w.seed("nowhere.test", [{ email: "kim@nowhere.test" }], null);
  const campaignId = await w.newCampaign();
  const id = await w.handOver(await w.cohort(), campaignId);
  await w.work(id);

  expect((await w.byEmail(id))["kim@nowhere.test"]).toMatchObject({ status: "added", missing: ["country"] });
  expect((await campaigns.people(w.W, campaignId)).people[0]).toMatchObject({ email: "kim@nowhere.test", blocked: "no basis recorded" });
  expect(await w.eligibility("kim@nowhere.test")).toMatchObject({ country: null, basis: null });
  const [kept] = await q(w.W, "select source, verification_result, snapshot_id, read_at, person_id from prospect_addresses where email = 'kim@nowhere.test'");
  expect(kept).toMatchObject({ source: "published", verification_result: "deliverable", snapshot_id: expect.any(String), read_at: expect.any(Date), person_id: expect.any(String) });

  // Entering only the country later brings back the basis and evidence the address went over with.
  const added = await campaigns.addPeople(w.W, campaignId, { csv: "email,country\nkim@nowhere.test,US", userId: U });
  expect(added).toMatchObject({ ok: true, results: [{ ok: true, missing: [] }] });
  expect(await w.eligibility("kim@nowhere.test")).toMatchObject({ country: "US", basis: "published_address" });
  const [record] = await q(w.W, "select e.evidence, e.country_confidence from person_eligibility e join person_keys k on k.person_id = e.person_id where k.value = 'kim@nowhere.test'");
  expect(record).toMatchObject({ evidence: expect.stringContaining("Address published on the company's site"), country_confidence: "inferred" });
  expect((await campaigns.people(w.W, campaignId)).people[0]).toMatchObject({ email: "kim@nowhere.test", blocked: null });
});

test("someone removed from the Campaign, suppressed or already contacted is left out with the reason", async () => {
  const w = await world();
  await w.seed("left.test", [{ email: "removed@left.test" }, { email: "optout@left.test" }, { email: "sent@left.test" }]);
  const campaignId = await w.newCampaign();
  const cohortId = await w.cohort();
  const first = await w.handOver(cohortId, campaignId);
  await outreach.addSuppression(w.W, "optout@left.test");
  const sent = await items.createActionItem(w.W, { idempotencyKey: crypto.randomUUID(), capability: POST, dedupe: "blind", spec: { to: ["sent@left.test"], body: "hello" }, actor: { userId: U }, details: { title: "An email", warnings: [] } });
  const submitted = await items.submitItem(w.W, sent.id, { userId: U });
  if (!submitted.ok) throw new Error(submitted.reason);
  expect((await send("POST", w.url(`/items/${sent.id}/approve`), owner, { revision: submitted.item.revision })).status).toBe(200);
  await ledger.run(w.W, await actionIdOf(w.W, sent.id));
  await w.work(first);
  const r1 = await w.byEmail(first);
  expect(r1["optout@left.test"]).toMatchObject({ status: "left_out", reason: "suppressed", personId: expect.any(String) });
  expect(r1["sent@left.test"]).toMatchObject({ status: "left_out", reason: "already_contacted" });
  const removed = r1["removed@left.test"]!;
  expect(removed.status).toBe("added");

  expect((await send("DELETE", w.url(`/campaigns/${campaignId}/people/${removed.personId}`), owner)).status).toBe(200);
  const again = await w.handOver(cohortId, campaignId);
  await w.work(again);
  expect((await w.byEmail(again))["removed@left.test"]).toMatchObject({ status: "left_out", reason: "removed", personId: removed.personId });
  expect((await campaigns.people(w.W, campaignId)).people).toEqual([expect.objectContaining({ personId: removed.personId, status: "removed" })]);
});

test("a Person live in another Campaign gets the existing conflict Item", async () => {
  const w = await world();
  await w.seed("busy.test", [{ email: "busy@busy.test" }]);
  const elsewhere = await w.newCampaign();
  const added = await campaigns.addPeopleRows(w.W, elsewhere, [{ email: "busy@busy.test", firstName: "Busy", company: null, website: null, country: "GB", basis: "consent", evidence: "Signed up" }], { userId: U });
  expect(added.ok && added.results[0]!.status).toBe("added");
  const campaignId = await w.newCampaign();
  const id = await w.handOver(await w.cohort(), campaignId);
  await w.work(id);

  const r = (await w.byEmail(id))["busy@busy.test"]!;
  expect(r).toMatchObject({ status: "conflict", conflictItemId: expect.any(String) });
  const conflict = (await items.view(w.W, r.conflictItemId!))!;
  expect(conflict.kind).toBe(CONFLICT_KIND);
  // It needs a choice, so approve-all leaves it out.
  expect(conflict.clean).toBe(false);
  expect((await campaigns.people(w.W, campaignId)).people[0]).toMatchObject({ conflict: { itemId: r.conflictItemId } });
});

test("the preview says about how many would go over and why the rest are skipped, writes nothing, and matches the hand-over", async () => {
  const w = await world();
  await w.seed("peek.test", [{ email: "ok@peek.test" }, { email: "optout@peek.test" }, { email: "sent@peek.test" }, { email: "gone@peek.test", verification: "invalid" }, { email: "new@peek.test", verification: null }]);
  await w.seed("north.test", [{ email: "guess@north.test", source: "guessed" }], "CA");
  await outreach.addSuppression(w.W, "optout@peek.test");
  const sent = await items.createActionItem(w.W, { idempotencyKey: crypto.randomUUID(), capability: POST, dedupe: "blind", spec: { to: ["sent@peek.test"], body: "hello" }, actor: { userId: U }, details: { title: "An email", warnings: [] } });
  const submitted = await items.submitItem(w.W, sent.id, { userId: U });
  if (!submitted.ok) throw new Error(submitted.reason);
  expect((await send("POST", w.url(`/items/${sent.id}/approve`), owner, { revision: submitted.item.revision })).status).toBe(200);
  await ledger.run(w.W, await actionIdOf(w.W, sent.id));
  const campaignId = await w.newCampaign();
  const cohortId = await w.cohort();

  const tables = ["people", "person_keys", "person_eligibility", "campaign_people", "prospect_handovers", "prospect_handover_results", "items", "actions", "suppressions"];
  const counts = () => q(w.W, `select ${tables.map((t) => `(select count(*) from ${t})::int as ${t}`).join(", ")}, (select count(*) from prospect_addresses where verified_at is not null)::int as checked`);
  const before = await counts();
  vendor.calls.length = 0;
  const r = await send("POST", w.url(`/prospecting/cohorts/${cohortId}/add-to-campaign/preview`), owner, { campaignId });
  expect(r.status).toBe(200);
  const preview = (await r.json()) as { added: number; skipped: { reason: string; count: number }[] };
  expect(preview.added).toBe(2);
  expect(preview.skipped.sort((a, b) => a.reason.localeCompare(b.reason))).toEqual(["already_contacted", "guess_in_canada", "not_deliverable", "suppressed"].map((reason) => ({ reason, count: 1 })));
  expect(await counts()).toEqual(before);
  expect(vendor.calls).toEqual([]);

  // The real hand-over ends the way the preview said.
  const id = await w.handOver(cohortId, campaignId);
  await w.work(id);
  const done = await w.view(id);
  expect(done.counts.added! + done.counts.joined!).toBe(preview.added);
  expect(done.counts.leftOut).toBe(4);

  // Who may be contacted now shows the name, company and Campaign they went over with.
  const row = (await outreach.overview(w.W)).people.find((p) => p.email === "ok@peek.test");
  expect(row).toMatchObject({ name: "Jane", company: "peek.test Ltd", campaign: { id: campaignId, title: "Q4" }, lastEmailAt: null, replied: false });

  expect((await send("POST", w.url(`/prospecting/cohorts/${cohortId}/add-to-campaign/preview`), owner, { campaignId: crypto.randomUUID() })).status).toBe(404);
});

test("a cohort of one search hands over only that search's companies, and then names the Campaign it was used by", async () => {
  const w = await world();
  const { runId } = await w.seed("searched.test", [{ email: "kim@searched.test" }, { email: "lee@searched.test" }]);
  await w.seed("pasted.test", [{ email: "pat@pasted.test" }]);
  const campaignId = await w.newCampaign();
  const cohortId = await w.cohort({ runs: [runId] });
  const id = await w.handOver(cohortId, campaignId);
  await w.work(id);
  const done = await w.view(id);
  expect(done.results.map((r) => r.email).sort()).toEqual(["kim@searched.test", "lee@searched.test"]);
  expect(done).toMatchObject({ cohortName: "Everyone", campaignTitle: "Q4", counts: { added: 2 } });

  const segment = await read<{ count: number; inCampaign: number; usedBy: unknown[] }>(w.url(`/prospecting/cohorts/${cohortId}`));
  expect(segment).toMatchObject({ count: 2, inCampaign: 2, usedBy: [{ campaignId, title: "Q4", people: 2, lastAddedAt: NOW.toISOString() }] });
  // Handing it over again adds no one new, and the Campaign is listed once.
  await w.work(await w.handOver(cohortId, campaignId));
  expect(await read(w.url(`/prospecting/cohorts/${cohortId}`))).toMatchObject({ inCampaign: 2, usedBy: [{ campaignId, people: 2 }] });
});

test("a cohort larger than a batch goes over in batches, and one that fails is tried again without adding anyone twice", async () => {
  const w = await world();
  const emails = Array.from({ length: 7 }, (_, i) => `p${i}@many.test`);
  await w.seed("many.test", emails.map((email) => ({ email })));
  const campaignId = await w.newCampaign();
  const cohortId = await w.cohort();
  const id = await w.handOver(cohortId, campaignId);
  calls.length = 0;
  failing.calls.add(2);
  await expect(w.work(id)).rejects.toThrow("the database went away");
  expect(await w.view(id)).toMatchObject({ status: "running", counts: { added: 3, leftOut: 0 } });

  await w.work(id);
  // The first batch was saved before the failure, so the retry starts at the second.
  expect(calls).toEqual([3, 3, 3, 1]);
  const done = await w.view(id);
  expect(done).toMatchObject({ status: "done", counts: { added: 7, joined: 0, conflict: 0, leftOut: 0 } });
  expect(done.results.map((r) => r.email).sort()).toEqual(emails);
  expect((await campaigns.people(w.W, campaignId)).people).toHaveLength(7);

  // A finished hand-over run again does nothing, and handing the cohort over again adds nobody twice.
  await w.work(id);
  expect(calls).toHaveLength(4);
  const twice = await w.handOver(cohortId, campaignId);
  await w.work(twice);
  expect((await w.view(twice)).counts).toEqual({ added: 0, joined: 7, conflict: 0, leftOut: 0 });
  expect((await campaigns.people(w.W, campaignId)).people).toHaveLength(7);
  expect((await q<{ n: number }>(w.W, "select count(*)::int as n from prospect_handover_results where handover_id = $1", [id]))[0]!.n).toBe(7);
});

test("results are read a page at a time", async () => {
  const w = await world();
  await w.seed("paged.test", Array.from({ length: 101 }, (_, i) => ({ email: `p${String(i).padStart(3, "0")}@paged.test`, verification: "invalid" })));
  const id = await w.handOver(await w.cohort(), await w.newCampaign());
  await w.work(id);
  const first = await w.view(id);
  expect(first.results).toHaveLength(100);
  expect(first.counts.leftOut).toBe(101);
  const second = await w.view(id, first.next!);
  expect(second).toMatchObject({ results: [expect.objectContaining({ reason: "not_deliverable" })], next: null });
});

test("a Viewer can't hand over and can read progress; another Workspace's cohort, Campaign or hand-over is not found", async () => {
  const w = await world();
  const campaignId = await w.newCampaign();
  const cohortId = await w.cohort();
  const viewer = (await addMember(owner, w.W, "viewer")).cookie;
  const contributor = (await addMember(owner, w.W, "contributor")).cookie;
  const path = w.url(`/prospecting/cohorts/${cohortId}/add-to-campaign`);
  expect((await send("POST", path, viewer, { campaignId })).status).toBe(403);
  const r = await send("POST", path, contributor, { campaignId });
  expect(r.status).toBe(202);
  const { handoverId } = (await r.json()) as { handoverId: string };
  expect((await call(w.url(`/prospecting/handovers/${handoverId}`), viewer)).status).toBe(200);

  const stranger = await signIn();
  await createOrg(stranger);
  expect((await send("POST", path, stranger, { campaignId })).status).toBe(404);
  expect((await call(w.url(`/prospecting/handovers/${handoverId}`), stranger)).status).toBe(404);

  const other = await world();
  const otherCampaign = await other.newCampaign();
  expect((await send("POST", path, owner, { campaignId: otherCampaign })).status).toBe(404);
  expect((await send("POST", other.url(`/prospecting/cohorts/${cohortId}/add-to-campaign`), owner, { campaignId: otherCampaign })).status).toBe(404);
  expect((await call(other.url(`/prospecting/handovers/${handoverId}`), owner)).status).toBe(404);
});

test("a handed-over Person's signals come from their company, with how each address was found; anyone else has none", async () => {
  const w = await world();
  const { snapshotId } = await w.seed("signals.test", [{ email: "sales@signals.test" }, { email: "bo@signals.test", source: "guessed", name: "Bo Li" }]);
  await q(w.W, "update prospect_addresses set kind = 'function', name = null where email = 'sales@signals.test'");
  await q(
    w.W,
    `insert into prospect_signals (workspace_id, company_id, type, quote, page_url, snapshot_id, observed_on, created_at)
     select workspace_id, company_id, 'hiring', 'We are hiring a controller', page_url, id, '2026-10-30', now() from prospect_snapshots where id = $1`,
    [snapshotId],
  );
  const id = await w.handOver(await w.cohort(), await w.newCampaign());
  await w.work(id);
  const r = await w.byEmail(id);
  const role = r["sales@signals.test"]!.personId!;
  const guessed = r["bo@signals.test"]!.personId!;

  const signal = { type: "hiring", quote: "We are hiring a controller", pageUrl: "https://signals.test/team", observedOn: "2026-10-30" };
  expect(await signalsFor(w.W, role)).toEqual([signal]);
  expect(await signalsFor(w.W, guessed)).toEqual([signal]);
  expect(await addressLabelsFor(w.W, role)).toEqual({ roleAddress: true, guessedAddress: false });
  expect(await addressLabelsFor(w.W, guessed)).toEqual({ roleAddress: false, guessedAddress: true });
  const stranger = crypto.randomUUID();
  expect(await signalsFor(w.W, stranger)).toEqual([]);
  expect(await addressLabelsFor(w.W, stranger)).toEqual({ roleAddress: false, guessedAddress: false });
});

test("a hand-over whose job gave up stops saying why, keeps what it handed over, and a late give-up changes nothing", async () => {
  const w = await world();
  const emails = Array.from({ length: 5 }, (_, i) => `g${i}@gaveup.test`);
  await w.seed("gaveup.test", emails.map((email) => ({ email })));
  const campaignId = await w.newCampaign();
  const id = await w.handOver(await w.cohort(), campaignId);
  calls.length = 0;
  failing.calls.add(2);
  const error = await w.work(id).catch((e: unknown) => e);
  await handovers.giveUp({ workspaceId: w.W, handoverId: id }, error);
  expect(await w.view(id)).toMatchObject({ status: "failed", failureReason: "the database went away", counts: { added: 3 } });
  expect((await campaigns.people(w.W, campaignId)).people).toHaveLength(3);

  const done = await w.handOver(await w.cohort(), campaignId);
  await w.work(done);
  await handovers.giveUp({ workspaceId: w.W, handoverId: done }, new Error("too late"));
  expect(await w.view(done)).toMatchObject({ status: "done", failureReason: null });
});

test("a plan made over HTTP has its Campaign, owned by its creator, and a Draft takes no hand-over until approved", async () => {
  const w = await world();
  const cohortId = await w.cohort();
  const { id: planId } = (await (await send("POST", w.url("/plans"), owner, { title: "Draft" })).json()) as { id: string };
  const [draft] = await q<{ id: string; owner_user_id: string; created_by: string }>(w.W, "select c.id, c.owner_user_id, p.created_by from campaigns c join marketing_plans p on p.id = c.plan_id where c.plan_id = $1", [planId]);
  expect(draft).toMatchObject({ owner_user_id: U, created_by: U });
  expect((await send("POST", w.url(`/prospecting/cohorts/${cohortId}/add-to-campaign`), owner, { campaignId: draft!.id })).status).toBe(404);
  expect((await send("POST", w.url(`/prospecting/cohorts/${cohortId}/add-to-campaign/preview`), owner, { campaignId: draft!.id })).status).toBe(404);
  expect(await q(w.W, "select id from prospect_handovers where campaign_id = $1", [draft!.id])).toEqual([]);
});
