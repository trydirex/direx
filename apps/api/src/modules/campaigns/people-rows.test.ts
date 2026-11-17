// SPDX-License-Identifier: AGPL-3.0-only
// Adding people to a campaign as rows rather than CSV, through the entry points, with real plans,
// outreach, items and ledger: the same per-row path as the CSV, plus who is left out and why.
import { expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createFacts, factKinds } from "../facts/index";
import { actionIdOf, itemsWorld, person, POST } from "../items/fixtures/items";
import { createOutreach } from "../outreach/index";
import { createPlans, planKinds, type PlanBody } from "../plans/index";
import { campaignKinds, campaignOnPlanApproved, campaignOnPlanCreated, createCampaigns, MAX_ROWS, type PersonInput } from "./index";

const { W, items, who, ledger } = await itemsWorld({ kinds: { ...factKinds(), ...planKinds({ onPlanApproved: campaignOnPlanApproved({ items: () => items }) }), ...campaignKinds() } });
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const noDraft = async () => ({ ok: false as const, reason: "not_here" });
const noSend = () => {
  throw new Error("nothing is sent here");
};
const outreach = createOutreach({ items: () => items, send: noSend, baseUrl: () => "http://direx.test" });
const campaigns = createCampaigns({ plans, facts, items: () => items, outreach: () => outreach, startDraft: () => noDraft });
const actor = { userId: person.userId };
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};

const { draftRevision } = await plans.strategy(W);
const saved = ok(
  await plans.saveStrategyDraft(W, {
    revision: draftRevision,
    body: { schemaVersion: 1, whoFor: "Ops", personas: [], positioning: "Audit", channels: [{ key: "email", label: "Email", timing: "now", reason: "Read", basis: { kind: "assumption" } }], assumptions: [] },
  }),
);
const strategyItem = ok(await plans.submitStrategy(W, { revision: saved.revision, actor })).item;
ok(await items.approve(W, strategyItem.id, strategyItem.revision, who));

const body: PlanBody = {
  schemaVersion: 1,
  goal: "4 meetings",
  audience: "Ops",
  startsOn: "2026-11-01",
  endsOn: "2026-11-30",
  steps: [{ key: "first", on: "2026-11-03", title: "First" }],
  measures: [{ key: "m", label: "Meetings", target: "4", basis: { kind: "assumption" } }],
  budget: [{ label: "Mailbox", amountCents: null, currency: "USD", billedBy: "your_account" }],
  assumptions: [{ text: "A guess" }],
};
async function newCampaign() {
  const plan = await plans.createPlan(W, { title: "Q4", createdBy: person.userId });
  const { revision } = ok(await plans.savePlanDraft(W, plan.id, { revision: 0, body }));
  const { item } = ok(await plans.submitPlan(W, plan.id, { revision, actor }));
  ok(await items.approve(W, item.id, item.revision, who));
  return (await campaigns.list(W)).find((c) => c.planId === plan.id)!.id;
}
const address = () => `${crypto.randomUUID()}@acme.test`;
const row = (over: Partial<PersonInput> = {}): PersonInput => ({
  email: address(),
  firstName: "Jane",
  company: "Acme",
  website: "acme.test",
  country: "CA",
  basis: "published_address",
  evidence: "Published on https://acme.test/team, read 2026-11-02",
  ...over,
});
const add = (id: string, rows: PersonInput[]) => campaigns.addPeopleRows(W, id, rows, actor);
const results = async (id: string, rows: PersonInput[]) => ok(await add(id, rows)).results;
const recorded = async (email: string) => (await outreach.overview(W)).people.find((p) => p.email === email);

test("a new address is added with its country, basis and evidence recorded", async () => {
  const id = await newCampaign();
  const r = row({ basis: "legitimate_interest" });
  const [result] = await results(id, [r]);
  expect(result).toEqual({ status: "added", personId: expect.any(String), missing: [] });
  expect((await campaigns.people(W, id)).people).toEqual([{ personId: expect.any(String), status: "active", firstName: "Jane", company: "Acme", website: "https://acme.test/", email: r.email, blocked: null, country: expect.any(String), warnings: expect.any(Array), lastEmailAt: null, conflict: null }]);
  expect(await recorded(r.email)).toMatchObject({ country: "CA", basis: "legitimate_interest" });
});

test("an address a Person already has joins that Person, and adding twice adds nobody twice", async () => {
  const id = await newCampaign();
  const r = row();
  const known = ok(await outreach.ensurePerson(W, r.email.toUpperCase()));
  expect(await results(id, [r])).toEqual([{ status: "joined", personId: known.id, missing: [] }]);
  expect(await results(id, [r])).toEqual([{ status: "joined", personId: known.id, missing: [] }]);
  expect((await campaigns.people(W, id)).people).toHaveLength(1);
});

test("an opted-out address is left out, and nothing is recorded for it", async () => {
  const id = await newCampaign();
  const r = row();
  await outreach.addSuppression(W, r.email);
  expect(await results(id, [r])).toEqual([{ status: "suppressed", personId: expect.any(String) }]);
  expect((await campaigns.people(W, id)).people).toEqual([]);
  expect(await recorded(r.email)).toMatchObject({ country: null, basis: null });
});

test("a Person already sent something is left out", async () => {
  const id = await newCampaign();
  const r = row();
  const sent = await items.createActionItem(W, { idempotencyKey: crypto.randomUUID(), capability: POST, dedupe: "blind", spec: { to: [r.email], body: "hello" }, actor, details: { title: "An email", warnings: [] } });
  ok(await items.submitItem(W, sent.id, actor));
  const submitted = (await items.view(W, sent.id))!;
  ok(await items.approve(W, sent.id, submitted.revision, who));
  await ledger.run(W, await actionIdOf(W, sent.id));
  expect((await items.view(W, sent.id))!.state).toBe("sent");

  expect(await results(id, [r])).toEqual([{ status: "already_contacted", personId: expect.any(String) }]);
  expect((await campaigns.people(W, id)).people).toEqual([]);
});

test("a Person removed from the campaign stays removed, though the CSV brings them back", async () => {
  const id = await newCampaign();
  const r = row();
  const [first] = await results(id, [r]);
  const { personId } = first as { personId: string };
  ok(await campaigns.removePerson(W, id, personId, person.userId));
  expect(await results(id, [r])).toEqual([{ status: "removed", personId }]);
  expect((await campaigns.people(W, id)).people[0]).toMatchObject({ personId, status: "removed" });
  ok(await campaigns.addPeople(W, id, { csv: `email\n${r.email}`, userId: person.userId }));
  expect((await campaigns.people(W, id)).people[0]).toMatchObject({ personId, status: "active" });
});

test("a Person live in another campaign is added with the same conflict Item the CSV makes", async () => {
  const r = row();
  await results(await newCampaign(), [r]);
  const id = await newCampaign();
  const [result] = await results(id, [r]);
  expect(result).toMatchObject({ status: "conflict", missing: [] });
  const { conflictItemId } = result as { conflictItemId: string };
  expect((await campaigns.people(W, id)).people[0]).toMatchObject({ conflict: { itemId: conflictItemId } });
  expect((await items.view(W, conflictItemId))!.groupKey).toBe(`campaign:${id}`);

  const csvId = await newCampaign();
  ok(await campaigns.addPeople(W, csvId, { csv: `email\n${r.email}`, userId: person.userId }));
  const csvConflict = (await campaigns.people(W, csvId)).people[0]!.conflict!;
  expect((await items.view(W, csvConflict.itemId))!.kind).toBe((await items.view(W, conflictItemId))!.kind);
});

test("an unknown country adds the Person, names country as missing and keeps them out of drafts", async () => {
  const id = await newCampaign();
  const r = row({ country: null });
  expect(await results(id, [r])).toEqual([{ status: "added", personId: expect.any(String), missing: ["country"] }]);
  expect((await campaigns.people(W, id)).people[0]).toMatchObject({ email: r.email, blocked: "no basis recorded" });
});

test("evidence over the limit is cut to fit, not refused", async () => {
  const id = await newCampaign();
  const r = row({ evidence: "x".repeat(5000) });
  const [result] = await results(id, [r]);
  expect(result).toMatchObject({ status: "added", missing: [] });
  const c = await appClient();
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  const { rows } = await c.query("select evidence from person_eligibility where person_id = $1", [(result as { personId: string }).personId]);
  await c.end();
  expect(rows[0].evidence).toHaveLength(1000);
  expect(rows[0].evidence.endsWith("…")).toBe(true);
});

test("a bad row is refused with its reason, in its place, and the others still count", async () => {
  const id = await newCampaign();
  const list = await results(id, [row({ email: "not-an-email" }), row({ country: "Canada" }), row({ basis: "because" as never }), row({ website: "javascript:x" }), row()]);
  expect(list.map((r) => (r.status === "refused" ? r.reason : r.status))).toEqual(["bad_email", "bad_country", "bad_basis", "bad_website", "added"]);
  expect((await campaigns.people(W, id)).people).toHaveLength(1);
});

test("one row over the limit is refused whole, and one at the limit isn't", async () => {
  const id = await newCampaign();
  const rows = (n: number) => Array.from({ length: n }, () => row({ email: "not-an-email" }));
  expect(await add(id, rows(MAX_ROWS + 1))).toEqual({ ok: false, reason: "too_many_rows", limit: MAX_ROWS });
  expect(ok(await add(id, rows(MAX_ROWS))).results).toHaveLength(MAX_ROWS);
});

test("another Workspace's campaign takes no rows", async () => {
  const other = await itemsWorld();
  const otherFacts = createFacts({ items: () => other.items });
  const elsewhere = createCampaigns({ plans: createPlans({ items: () => other.items, facts: otherFacts, onPlanCreated: campaignOnPlanCreated }), facts: otherFacts, items: () => other.items, outreach: () => outreach, startDraft: () => noDraft });
  expect(await elsewhere.addPeopleRows(other.W, await newCampaign(), [row()], actor)).toEqual({ ok: false, reason: "not_found" });
});
