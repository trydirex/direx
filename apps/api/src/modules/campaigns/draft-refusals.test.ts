// SPDX-License-Identifier: AGPL-3.0-only
// ADR 0023 rule 002: a Campaign is made with its plan, and until a version is approved it is a Draft that
// takes no People, DMs, emails, step setup or settings. One test per write path, through the entry points.
import { afterAll, beforeAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createFacts, factKinds } from "../facts/index";
import { itemsWorld, person } from "../items/fixtures/items";
import { createOutreach } from "../outreach/index";
import { createPlans, planKinds, type PlanBody } from "../plans/index";
import { placeDraft, reviseDraft } from "./application/place-draft";
import { campaignOnPlanApproved, campaignOnPlanCreated, createCampaigns } from "./index";

const { W, items, who } = await itemsWorld({ kinds: { ...factKinds(), ...planKinds({ onPlanApproved: campaignOnPlanApproved({ items: () => items }) }) } });
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const noDraft = async () => ({ ok: false as const, reason: "not_here" });
const never = () => {
  throw new Error("a Draft must refuse before this");
};
const outreach = createOutreach({ items: () => items, send: never, baseUrl: () => "http://direx.test" });
const campaigns = createCampaigns({ plans, facts, items: () => items, outreach: () => outreach, startDraft: () => noDraft, outsideTouches: () => ({ log: never }) });
const actor = { userId: person.userId };
const REFUSED = { ok: false, reason: "plan_not_approved" };
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};

const body: PlanBody = {
  schemaVersion: 1,
  goal: "4 meetings",
  audience: "Ops",
  startsOn: "2099-11-01",
  endsOn: "2099-11-30",
  steps: [{ key: "first", on: "2099-11-03", title: "First" }],
  measures: [{ key: "m", label: "Meetings", target: "4", basis: { kind: "assumption" } }],
  budget: [{ label: "Mailbox", amountCents: null, currency: "USD", billedBy: "your_account" }],
  assumptions: [{ text: "A guess" }],
};

let c: Awaited<ReturnType<typeof appClient>>;
const q = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;
const campaignOf = async (planId: string) => (await q("select id from campaigns where plan_id = $1", [planId]))[0].id as string;

/** A plan with a draft but no approved version, and the Campaign made with it. Submitted, too, unless asked not to. */
async function draftCampaign(submit = true) {
  const plan = await plans.createPlan(W, { title: "Q4", createdBy: person.userId });
  const { revision } = ok(await plans.savePlanDraft(W, plan.id, { revision: 0, body }));
  if (submit) ok(await plans.submitPlan(W, plan.id, { revision, actor }));
  return campaignOf(plan.id);
}
async function approvedCampaign() {
  const plan = await plans.createPlan(W, { title: "Q4", createdBy: person.userId });
  const { revision } = ok(await plans.savePlanDraft(W, plan.id, { revision: 0, body }));
  const { item } = ok(await plans.submitPlan(W, plan.id, { revision, actor }));
  ok(await items.approve(W, item.id, item.revision, who));
  return campaignOf(plan.id);
}
/** What only a bug, or a row from before this rule, could put in a Draft: a DM step, a DM and an active Person. */
async function draftWithRows() {
  const id = await draftCampaign();
  const email = `${crypto.randomUUID()}@acme.test`;
  const p = ok(await outreach.ensurePerson(W, email));
  await q("insert into campaign_steps (workspace_id, campaign_id, step_key, type, touch_class, dm_channel, updated_at) values ($1, $2, 'first', 'dm', 'cold', 'linkedin', now())", [W, id]);
  await q("insert into campaign_people (workspace_id, campaign_id, person_id, added_by, at) values ($1, $2, $3, $4, now())", [W, id, p.id, person.userId]);
  const [dm] = await q("insert into campaign_dms (workspace_id, campaign_id, step_key, person_id, channel, profile_url, text, template_revision, created_at) values ($1, $2, 'first', $3, 'linkedin', 'https://linkedin.com/in/x', 'Hi', 0, now()) returning id", [W, id, p.id]);
  return { id, email, personId: p.id, dmId: dm.id as string };
}

beforeAll(async () => {
  c = await appClient();
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  const { draftRevision } = await plans.strategy(W);
  const saved = ok(
    await plans.saveStrategyDraft(W, {
      revision: draftRevision,
      body: { schemaVersion: 1, whoFor: "Ops", personas: [], positioning: "Audit", channels: [{ key: "email", label: "Email", timing: "now", reason: "Read", basis: { kind: "assumption" } }], assumptions: [] },
    }),
  );
  const strategyItem = ok(await plans.submitStrategy(W, { revision: saved.revision, actor })).item;
  ok(await items.approve(W, strategyItem.id, strategyItem.revision, who));
});
afterAll(() => c.end());

test("a Draft takes no People from a CSV, and nothing is written", async () => {
  const id = await draftCampaign(false);
  expect(await campaigns.addPeople(W, id, { csv: `email\n${crypto.randomUUID()}@acme.test`, userId: person.userId })).toEqual(REFUSED);
  expect(await q("select * from campaign_people where campaign_id = $1", [id])).toEqual([]);
});

test("a Draft takes no People as rows, which is the prospecting hand-over's path", async () => {
  const id = await draftCampaign();
  const row = { email: `${crypto.randomUUID()}@acme.test`, firstName: null, company: null, website: null, country: "US", basis: "published_address" as const, evidence: "Their page" };
  expect(await campaigns.addPeopleRows(W, id, [row], actor)).toEqual(REFUSED);
  expect(await q("select * from campaign_people where campaign_id = $1", [id])).toEqual([]);
});

test("a Person active in a Draft is not live there, so another Campaign raises no conflict", async () => {
  const draft = await draftWithRows();
  const live = await approvedCampaign();
  const [result] = ok(await campaigns.addPeopleRows(W, live, [{ email: draft.email, firstName: null, company: null, website: null, country: "US", basis: "published_address", evidence: "Their page" }], actor)).results;
  expect(result).toMatchObject({ status: "joined", personId: draft.personId });
});

test("a Draft's step takes no DM text, makes no DMs and logs no DM as sent", async () => {
  const { id, dmId } = await draftWithRows();
  expect(await campaigns.saveDmText(W, id, "first", { revision: 0, text: "Hi {{firstName}}" })).toEqual(REFUSED);
  expect(await campaigns.makeDms(W, id, "first")).toEqual(REFUSED);
  expect(await campaigns.markDmSent(W, dmId, person.userId)).toEqual(REFUSED);
  expect(await q("select sent_at from campaign_dms where id = $1", [dmId])).toEqual([{ sent_at: null }]);
});

test("no email is placed or revised in a Draft, which covers every writer's completion", async () => {
  const { id, personId } = await draftWithRows();
  const d = { items: () => items, outreach: () => ({ prepare: async () => ({ ok: true }) as never, composeIn: never, reviseIn: never }) };
  const p = { workspaceId: W, campaignId: id, stepKey: "first", personId, userId: person.userId };
  const email = { credentialId: crypto.randomUUID(), touchClass: "cold" as const, subject: "Hi", text: "Hello", warnings: [], snapshot: [], submit: true };
  expect(await placeDraft(d, p, email)).toEqual(REFUSED);
  expect(await reviseDraft(d, { ...p, itemId: crypto.randomUUID() }, email)).toMatchObject(REFUSED);
  expect(await q("select * from campaign_actions where campaign_id = $1", [id])).toEqual([]);
});

test("a Draft takes no step setup", async () => {
  const id = await draftCampaign();
  expect(await campaigns.setupStep(W, id, "first", { type: "manual", touchClass: "cold", mailboxCredentialId: null, audience: "everyone" })).toEqual(REFUSED);
  expect(await q("select * from campaign_steps where campaign_id = $1", [id])).toEqual([]);
});

test("a Draft takes no settings: drafting modes, outside content or advance", async () => {
  const id = await draftCampaign();
  expect(await campaigns.setDraftingMode(W, id, "template")).toEqual(REFUSED);
  expect(await campaigns.setStepDraftingMode(W, id, "first", "template")).toEqual(REFUSED);
  expect(await campaigns.setOutsideContent(W, id, { allowed: true, userId: person.userId })).toEqual(REFUSED);
  expect(await campaigns.setAdvance(W, id, { advance: "run", timeZone: "UTC", userId: person.userId })).toEqual(REFUSED);
  expect(await q("select drafting_mode, outside_content_allowed, advance from campaigns where id = $1", [id])).toEqual([{ drafting_mode: null, outside_content_allowed: false, advance: "offer" }]);
});

test("a Draft's launch can't be moved or set to follow a step", async () => {
  const id = await draftCampaign();
  expect(await campaigns.moveAnchor(W, id, { on: "2099-12-01" }, actor)).toEqual(REFUSED);
  expect(await campaigns.followStep(W, id, null, actor)).toEqual(REFUSED);
  expect(await q("select anchor_on, anchor_step_key from campaigns where id = $1", [id])).toEqual([{ anchor_on: null, anchor_step_key: null }]);
});

test("the paths that read the approved version refuse a Draft too", async () => {
  const { id } = await draftWithRows();
  const refused = [
    await campaigns.makeDrafts(W, id, "first", { timeZone: "UTC", userId: person.userId }),
    await campaigns.writePerPerson(W, id, "first", { timeZone: "UTC", userId: person.userId }),
    await campaigns.confirmDrafting(W, id, { timeZone: "UTC", userId: person.userId }),
    await campaigns.draftPosts(W, id, "first", { plannedAt: new Date(), targets: [] }, person.userId),
    await campaigns.makeClips(W, id, "first", { sourceMediaId: crypto.randomUUID(), accounts: [], firstAt: new Date() }, person.userId),
    await campaigns.makeBrief(W, id, "first", { page: null, query: "acme" }, person.userId),
    await campaigns.recordOutput(W, id, "first", "https://acme.test/launch", actor),
  ];
  for (const r of refused) expect(r.ok).toBe(false);
  expect(await q("select * from campaign_actions where campaign_id = $1", [id])).toEqual([]);
});
