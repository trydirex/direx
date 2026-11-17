// SPDX-License-Identifier: AGPL-3.0-only
// From an approved plan to its campaign, through the entry points, with real plans and real Items.
import { afterAll, beforeAll, expect, test } from "vitest";
import { appClient, insertAuthUser } from "../../../../../test/db";
import { createFacts, factKinds } from "../facts/index";
import { itemsWorld, person } from "../items/fixtures/items";
import { createPlans, planKinds, type OnPlanApproved, type PlanBody, type StrategyBody } from "../plans/index";
import { campaignKinds, campaignOnPlanApproved, campaignOnPlanCreated, createCampaigns, type StartDraft } from "./index";

const created = campaignOnPlanApproved({ items: () => items });
let hook: OnPlanApproved = created;
const world = await itemsWorld({ kinds: { ...factKinds(), ...planKinds({ onPlanApproved: (tx, p) => hook(tx, p) }), ...campaignKinds() } });
const { W, items, who } = world;
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const noOutreach = () => {
  throw new Error("these tests add no people");
};
const noDraft: StartDraft = async () => ({ ok: false, reason: "not_here" });
const campaigns = createCampaigns({ plans, facts, items: () => items, outreach: noOutreach, startDraft: () => noDraft });
const actor = { userId: person.userId };
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};

const strategy: StrategyBody = {
  schemaVersion: 1,
  whoFor: "Heads of ecommerce ops",
  personas: [],
  positioning: "The audit that finds the error",
  channels: [{ key: "email", label: "Cold email", timing: "now", reason: "Ops leads read email", basis: { kind: "assumption" } }],
  assumptions: [],
};
const planBody = (steps: PlanBody["steps"]): PlanBody => ({
  schemaVersion: 1,
  goal: "4 meetings",
  audience: "Shopify ops leads",
  startsOn: "2026-11-01",
  endsOn: "2026-11-30",
  steps,
  measures: [{ key: "meetings", label: "Meetings", target: "4", basis: { kind: "assumption" } }],
  budget: [{ label: "Mailbox", amountCents: null, currency: "USD", billedBy: "your_account" }],
  assumptions: [{ text: "Which opening line works" }],
});
const FIRST = { key: "first", on: "2026-11-03", channelKey: "email", title: "First email" };
const SECOND = { key: "second", on: "2026-11-10", channelKey: "email", title: "Follow-up" };

let c: Awaited<ReturnType<typeof appClient>>;
const count = async (table: string) => Number((await c.query(`select count(*) from ${table}`)).rows[0].count);

beforeAll(async () => {
  c = await appClient();
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  const { draftRevision } = await plans.strategy(W);
  const { revision } = ok(await plans.saveStrategyDraft(W, { revision: draftRevision, body: strategy }));
  const { item } = ok(await plans.submitStrategy(W, { revision, actor }));
  ok(await items.approve(W, item.id, item.revision, who));
});
afterAll(() => c.end());

async function approveVersion(planId: string, body: PlanBody) {
  const { draftRevision } = (await plans.plan(W, planId))!;
  const { revision } = ok(await plans.savePlanDraft(W, planId, { revision: draftRevision, body }));
  const { item } = ok(await plans.submitPlan(W, planId, { revision, actor }));
  return items.approve(W, item.id, item.revision, who);
}
const newPlan = async () => (await plans.createPlan(W, { title: "Q4", createdBy: person.userId })).id;
const campaignOf = async (planId: string) => (await campaigns.list(W)).filter((x) => x.planId === planId);

test("a new plan has its Campaign from the start, owned by who started it, and the list shows it as a Draft", async () => {
  const planId = await newPlan();
  const { rows } = await c.query("select owner_user_id from campaigns where plan_id = $1", [planId]);
  expect(rows).toEqual([{ owner_user_id: person.userId }]);
  expect((await campaignOf(planId)).map((x) => x.status)).toEqual(["draft"]);
  expect(await campaigns.campaignIdOfPlan(W, planId)).toBe((await campaignOf(planId))[0]!.id);
  expect(await campaigns.campaignIdOfPlan(W, crypto.randomUUID())).toBeUndefined();
});

test("if making its Campaign fails, no plan is made", async () => {
  const failing = createPlans({ items: () => items, facts, onPlanCreated: async () => { throw new Error("no campaign"); } });
  const before = await count("marketing_plans");
  await expect(failing.createPlan(W, { title: "Q4", createdBy: person.userId })).rejects.toThrow("no campaign");
  expect(await count("marketing_plans")).toBe(before);
});

test("approving a version someone else submitted keeps the plan's creator as its owner", async () => {
  const creator = crypto.randomUUID();
  await insertAuthUser(creator);
  const planId = (await plans.createPlan(W, { title: "Q4", createdBy: creator })).id;
  ok(await approveVersion(planId, planBody([FIRST])));
  expect((await campaignOf(planId))[0]!.ownerUserId).toBe(creator);
  expect((await c.query("select created_by from marketing_plans where id = $1", [planId])).rows).toEqual([{ created_by: creator }]);
});

test("approving a plan makes one campaign, unanswered, owned by who wrote it, and nothing else", async () => {
  const before = { actions: await count("actions"), touches: await count("touch_reservations"), calls: await count("model_calls"), runs: await count("agent_runs") };
  const planId = await newPlan();
  ok(await approveVersion(planId, planBody([FIRST])));

  const [campaign] = await campaignOf(planId);
  expect(campaign).toMatchObject({ draftingMode: null, ownerUserId: person.userId, paused: false });
  // The list row carries what its card shows; a new campaign has done, sent and replied nothing yet.
  expect(campaign).toMatchObject({ done: 0, sent: 0, replied: 0, needApproval: 0, startsOn: expect.any(String), endsOn: expect.any(String) });
  expect({ actions: await count("actions"), touches: await count("touch_reservations"), calls: await count("model_calls"), runs: await count("agent_runs") }).toEqual(before);
});

test("the list counts everything of a campaign that waits for a person, not only its emails", async () => {
  const planId = await newPlan();
  ok(await approveVersion(planId, planBody([FIRST])));
  const [c] = await campaignOf(planId);
  const wait = (groupKey: string) =>
    items.createItem(W, { kind: "fact_proposal", payload: {}, actor, details: { title: "A post", workArea: "social", channel: "linkedin", warnings: [], plannedAt: null, groupKey } });
  ok(await wait(`campaign:${c!.id}:step:post`));
  ok(await wait(`campaign:${c!.id}`));
  // Another campaign whose id starts the same isn't counted.
  ok(await wait(`campaign:${c!.id}0:step:post`));
  expect((await campaignOf(planId))[0]!.needApproval).toBe(2);
});

test("approving a later version makes no second campaign", async () => {
  const planId = await newPlan();
  ok(await approveVersion(planId, planBody([FIRST])));
  const [first] = await campaignOf(planId);
  ok(await approveVersion(planId, planBody([FIRST, SECOND])));
  expect((await campaignOf(planId)).map((c) => c.id)).toEqual([first!.id]);
});

test("if making the campaign fails, the plan isn't approved", async () => {
  const planId = await newPlan();
  hook = async () => {
    throw new Error("no campaign");
  };
  try {
    await approveVersion(planId, planBody([FIRST])).catch(() => undefined);
  } finally {
    hook = created;
  }
  expect((await plans.plan(W, planId))!.currentVersion).toBeNull();
  expect((await campaignOf(planId)).map((x) => x.status)).toEqual(["awaiting_signoff"]);
});

test("a campaign shows the plan's steps, unset steps are manual", async () => {
  const planId = await newPlan();
  ok(await approveVersion(planId, planBody([FIRST, SECOND])));
  const [row] = await campaignOf(planId);
  ok(await campaigns.setupStep(W, row!.id, "first", { type: "email", touchClass: "cold", mailboxCredentialId: null, audience: "everyone" }));

  const campaign = (await campaigns.campaign(W, row!.id))!;
  expect(campaign).toMatchObject({ title: "Q4", goal: "4 meetings", startsOn: "2026-11-01", planned: 2, done: 0 });
  expect(campaign.steps).toMatchObject([
    { key: "first", on: "2026-11-03", title: "First email", inPlan: true, type: "email" },
    { key: "second", on: "2026-11-10", title: "Follow-up", inPlan: true, type: "manual", mailboxCredentialId: null },
  ]);
});

test("a new plan version leaves a dropped step's setup, shown as no longer in the plan", async () => {
  const planId = await newPlan();
  ok(await approveVersion(planId, planBody([FIRST, SECOND])));
  const [row] = await campaignOf(planId);
  ok(await campaigns.setupStep(W, row!.id, "second", { type: "email", touchClass: "cold", mailboxCredentialId: null, audience: "no_reply_yet" }));

  ok(await approveVersion(planId, planBody([FIRST])));
  expect((await campaigns.campaign(W, row!.id))!.steps).toMatchObject([
    { key: "first", inPlan: true },
    { key: "second", inPlan: false, on: null, title: "Follow-up", type: "email", audience: "no_reply_yet" },
  ]);
});

test("a step outside the plan, or a Mailbox that isn't there, is refused", async () => {
  const planId = await newPlan();
  ok(await approveVersion(planId, planBody([FIRST])));
  const [row] = await campaignOf(planId);
  const setup = { type: "email", touchClass: "cold", mailboxCredentialId: null, audience: "everyone" };
  expect(await campaigns.setupStep(W, row!.id, "nope", setup)).toEqual({ ok: false, reason: "step_not_in_plan" });
  expect(await campaigns.setupStep(W, row!.id, "first", { ...setup, mailboxCredentialId: crypto.randomUUID() })).toEqual({ ok: false, reason: "mailbox_not_found" });
});

test("an archived plan's campaign leaves the list", async () => {
  const planId = await newPlan();
  ok(await approveVersion(planId, planBody([FIRST])));
  ok(await plans.archivePlan(W, planId));
  expect((await campaigns.list(W)).some((c) => c.planId === planId)).toBe(false);
});

test("another Workspace's campaign can't be read or set up", async () => {
  const planId = await newPlan();
  ok(await approveVersion(planId, planBody([FIRST])));
  const [row] = await campaignOf(planId);
  const other = await itemsWorld();
  const otherFacts = createFacts({ items: () => other.items });
  const elsewhere = createCampaigns({ plans: createPlans({ items: () => other.items, facts: otherFacts, onPlanCreated: campaignOnPlanCreated }), facts: otherFacts, items: () => other.items, outreach: noOutreach, startDraft: () => noDraft });
  expect(await elsewhere.campaign(other.W, row!.id)).toBeUndefined();
  expect(await elsewhere.setupStep(other.W, row!.id, "first", { type: "manual", touchClass: "cold", mailboxCredentialId: null, audience: "everyone" })).toEqual({ ok: false, reason: "not_found" });
  expect(await elsewhere.list(other.W)).toEqual([]);
});

const emailSetup = { type: "email", touchClass: "cold", mailboxCredentialId: null, audience: "everyone" };
const modes = async (id: string) => Object.fromEntries((await campaigns.campaign(W, id))!.steps.map((s) => [s.key, s.draftingMode]));

test("a new email step gets its mode from where it sits: the first is per Person when outside content is allowed", async () => {
  const planId = await newPlan();
  ok(await approveVersion(planId, planBody([FIRST, SECOND])));
  const [row] = await campaignOf(planId);
  ok(await campaigns.setOutsideContent(W, row!.id, { allowed: true, userId: person.userId }));
  ok(await campaigns.setupStep(W, row!.id, "first", emailSetup));
  ok(await campaigns.setupStep(W, row!.id, "second", emailSetup));
  expect(await modes(row!.id)).toEqual({ first: "per_person", second: "template" });

  const without = await newPlan();
  ok(await approveVersion(without, planBody([FIRST, SECOND])));
  const [plain] = await campaignOf(without);
  ok(await campaigns.setupStep(W, plain!.id, "first", emailSetup));
  ok(await campaigns.setupStep(W, plain!.id, "second", { ...emailSetup, type: "manual" }));
  expect(await modes(plain!.id)).toEqual({ first: "template", second: null });
});

test("a Campaign answered before modes moved to steps sets every email step, now and later", async () => {
  const planId = await newPlan();
  ok(await approveVersion(planId, planBody([FIRST, SECOND])));
  const [row] = await campaignOf(planId);
  ok(await campaigns.setupStep(W, row!.id, "first", emailSetup));
  ok(await campaigns.setDraftingMode(W, row!.id, "per_person"));
  ok(await campaigns.setupStep(W, row!.id, "second", emailSetup));
  expect(await modes(row!.id)).toEqual({ first: "per_person", second: "per_person" });
});

test("a step's mode changes until that step has a draft, and only an email step has one", async () => {
  const planId = await newPlan();
  ok(await approveVersion(planId, planBody([FIRST, SECOND])));
  const [row] = await campaignOf(planId);
  ok(await campaigns.setupStep(W, row!.id, "first", emailSetup));
  ok(await campaigns.setupStep(W, row!.id, "second", emailSetup));
  ok(await campaigns.setStepDraftingMode(W, row!.id, "second", "per_person"));
  expect(await modes(row!.id)).toEqual({ first: "template", second: "per_person" });

  ok(await campaigns.saveTemplate(W, row!.id, "first", { revision: 0, subject: "Hi {{firstName}}", text: "Hello {{firstName}}.", userId: person.userId }));
  expect(await campaigns.setStepDraftingMode(W, row!.id, "first", "per_person")).toEqual({ ok: false, reason: "drafting_mode_locked" });
  // The other step has nothing written, so it can still change.
  ok(await campaigns.setStepDraftingMode(W, row!.id, "second", "template"));
  ok(await campaigns.setupStep(W, row!.id, "second", { ...emailSetup, type: "manual" }));
  expect(await campaigns.setStepDraftingMode(W, row!.id, "second", "template")).toEqual({ ok: false, reason: "not_an_email_step" });
});

test("an email step starts with the text its plan wrote, checked like a person's, and a step the plan wrote none for starts empty", async () => {
  const planId = await newPlan();
  const written = { ...FIRST, template: { subject: "Hi {{firstName}}", text: "We cut close time by 40% for teams like {{company}}.", citations: [{ factId: crypto.randomUUID(), version: 1 }] } };
  ok(await approveVersion(planId, planBody([written, SECOND])));
  const [row] = await campaignOf(planId);
  ok(await campaigns.setupStep(W, row!.id, "first", emailSetup));
  ok(await campaigns.setupStep(W, row!.id, "second", emailSetup));
  const [first, second] = (await campaigns.campaign(W, row!.id))!.steps;
  expect(first).toMatchObject({ templateRevision: 1, template: { subject: "Hi {{firstName}}", text: written.template.text } });
  // The cited Fact isn't there, so the number has no source, as it would in a person's edit.
  expect(first!.template!.warnings.map((w) => w.code)).toContain("uncited_number");
  expect(second).toMatchObject({ templateRevision: 0, template: null });
  // Setting the step up again leaves its text alone: the step owns it now.
  ok(await campaigns.saveTemplate(W, row!.id, "first", { revision: 1, subject: "Edited", text: "Hello {{firstName}}.", userId: person.userId }));
  ok(await campaigns.setupStep(W, row!.id, "first", { ...emailSetup, audience: "no_reply_yet" }));
  expect((await campaigns.campaign(W, row!.id))!.steps[0]).toMatchObject({ templateRevision: 2, template: { subject: "Edited" } });
});
