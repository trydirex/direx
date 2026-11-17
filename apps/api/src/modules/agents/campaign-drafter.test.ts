// SPDX-License-Identifier: AGPL-3.0-only
// A template run through the real loop, models, facts and items. Only the provider is local.
import type { PgBoss } from "pg-boss";
import { afterAll, expect, test } from "vitest";
import * as repo from "./adapters/repo";
import { createLoop } from "./application/loop";
import { createOffers } from "./application/offers";
import { createProposals } from "./application/proposals";
import { createRuns } from "./application/runs";
import type { DraftInput } from "./index";
import { campaignDefinitions, campaignDrafter, campaignOnPlanApproved, campaignOnPlanCreated, campaignSinks, createCampaigns } from "../campaigns/index";
import { createFacts, factKinds } from "../facts/index";
import { itemsWorld, person } from "../items/fixtures/items";
import { createModels } from "../models/index";
import { anthropicText, anthropicTool, fakeProvider, testKeys, type Received } from "../models/fixtures/provider";
import { createOutreach } from "../outreach/index";
import { createPlans, planKinds, type PlanBody } from "../plans/index";

const fake = fakeProvider();
afterAll(() => fake.stop());

const { W, items, who } = await itemsWorld({ kinds: { ...factKinds(), ...planKinds({ onPlanApproved: campaignOnPlanApproved({ items: () => items }) }) } });
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const noSend = () => {
  throw new Error("nothing is sent here");
};
const outreach = createOutreach({ items: () => items, send: noSend, baseUrl: () => "http://direx.test" });
const campaigns = createCampaigns({ plans, facts, items: () => items, outreach: () => outreach, startDraft: () => async () => ({ ok: false, reason: "not_here" }) });
const me = { kind: "person" as const, label: "Sam" };
const actor = { userId: person.userId };
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};

const now = () => new Date();
const runs = createRuns({ boss: { send: async () => {} } as unknown as PgBoss, now, notify: async () => {}, warnItem: async () => {} });
const models = createModels({ deployment: "self_host", keys: testKeys("sk-test"), baseURLs: { anthropic: fake.url }, runGate: runs.runGate, now });
const accept = createProposals({ definitions: campaignDefinitions, sinks: campaignSinks({ facts }), warnItem: async () => {}, now });
const fetchPage = async () => {
  throw new Error("this drafter has no pages to read");
};
const loop = createLoop({ models, runs, fetchPage, now, definitions: campaignDefinitions, context: async () => [], accept });

const { draftRevision } = await plans.strategy(W);
const saved = ok(
  await plans.saveStrategyDraft(W, {
    revision: draftRevision,
    body: { schemaVersion: 1, whoFor: "Ops", personas: [], positioning: "The audit that finds the error", channels: [{ key: "email", label: "Email", timing: "now", reason: "Read", basis: { kind: "assumption" } }], assumptions: [] },
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
  steps: [{ key: "first", on: "2026-11-03", title: "First email" }],
  measures: [{ key: "m", label: "Meetings", target: "4", basis: { kind: "assumption" } }],
  budget: [],
  assumptions: [],
};
async function ready() {
  const plan = await plans.createPlan(W, { title: "Q4", createdBy: person.userId });
  const { revision } = ok(await plans.savePlanDraft(W, plan.id, { revision: 0, body }));
  const { item } = ok(await plans.submitPlan(W, plan.id, { revision, actor }));
  ok(await items.approve(W, item.id, item.revision, who));
  const id = (await campaigns.list(W)).find((c) => c.planId === plan.id)!.id;
  ok(await campaigns.setDraftingMode(W, id, "template"));
  ok(await campaigns.setupStep(W, id, "first", { type: "email", touchClass: "cold", mailboxCredentialId: null, audience: "everyone" }));
  return { id, input: ok(await campaigns.draftInput(W, id, "first")).input as DraftInput };
}

let received: Received[] = [];
const script = (...steps: (() => Response)[]) => {
  let i = 0;
  received = [];
  fake.respondWith((r) => {
    received.push(r);
    return steps[Math.min(i++, steps.length - 1)]!();
  });
};
const run = async (input: DraftInput) => {
  const started = await runs.start(W, { definition: campaignDrafter, input, idempotencyKey: crypto.randomUUID(), trigger: "person" });
  await loop.execute((await runs.wake({ workspaceId: W, runId: started.id }))!);
  return repo.inWorkspace(W, async (tx) => ({ run: (await repo.readRun(tx, started.id))!, parts: await repo.partsOf(tx, started.id), proposals: await repo.proposalsOf(tx, started.id) }));
};
const email = (text: string, citations: { factId: string; version: number }[] = [], subject = "A quick question") => ({ schemaVersion: 1, subject, text, citations });
const templateOf = async (id: string) => (await campaigns.campaign(W, id))!.steps[0]!;
const needing = async () => (await items.list(W, { state: "needs_approval", limit: 200, offset: 0 })).items.length;

test("a run fills one step's template, offers only propose, and makes no Item", async () => {
  const { id, input } = await ready();
  const before = await needing();
  script(() => anthropicTool("propose", email("Hi {{firstName}}, we audit stores.")));
  const r = await run(input);
  expect(r.run.status).toBe("succeeded");
  expect((received[0]!.body as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(["propose"]);
  expect(JSON.stringify(received[0]!.body)).toContain("The audit that finds the error");
  expect(r.proposals).toMatchObject([{ kind: "draft", itemId: null, rejectionCode: null }]);
  expect(await templateOf(id)).toMatchObject({ templateRevision: 1, template: { text: "Hi {{firstName}}, we audit stores.", warnings: [], needsDecision: [] } });
  expect(await needing()).toBe(before);
});

test("the record holds no Person, even with people in the campaign", async () => {
  const { id, input } = await ready();
  ok(await campaigns.addPeople(W, id, { csv: "email,company\nsecret-person@acme.test,Hidden Co", userId: person.userId }));
  const again = ok(await campaigns.draftInput(W, id, "first")).input;
  script(() => anthropicTool("propose", email("Hi {{firstName}}.")));
  const r = await run(again);
  expect(r.run.tainted).toBe(false);
  const seen = JSON.stringify([received, r.parts, r.run.input, input]);
  expect(seen).not.toContain("secret-person");
  expect(seen).not.toContain("Hidden Co");
});

test("garbage changes nothing and records why, and a field that doesn't exist is refused", async () => {
  const { id, input } = await ready();
  script(() => anthropicTool("propose", { nonsense: true }));
  expect((await run(input)).run).toMatchObject({ status: "failed", statusReason: "invalid_output" });
  script(() => anthropicText("Sure, here it is"));
  expect((await run(input)).run).toMatchObject({ status: "failed", statusReason: "free_text" });
  expect(await templateOf(id)).toMatchObject({ templateRevision: 0, template: null });

  script(() => anthropicTool("propose", email("Hi {{jobTitle}}.")));
  expect((await run(input)).proposals).toMatchObject([{ rejectionCode: "unknown_merge_field" }]);
  expect(await templateOf(id)).toMatchObject({ templateRevision: 0, template: null });
});

test("a step waiting on another may link to it through that step's field, and to nothing else", async () => {
  const plan = await plans.createPlan(W, { title: "Launch", createdBy: person.userId });
  const linkedBody: PlanBody = { ...body, steps: [{ key: "page", on: "2026-11-02", title: "Launch page" }, ...body.steps] };
  const { revision } = ok(await plans.savePlanDraft(W, plan.id, { revision: 0, body: linkedBody }));
  const { item } = ok(await plans.submitPlan(W, plan.id, { revision, actor }));
  ok(await items.approve(W, item.id, item.revision, who));
  const id = (await campaigns.list(W)).find((c) => c.planId === plan.id)!.id;
  ok(await campaigns.setDraftingMode(W, id, "template"));
  ok(await campaigns.setupStep(W, id, "first", { type: "email", touchClass: "cold", mailboxCredentialId: null, audience: "everyone", dependsOnStepKey: "page" }));
  const input = ok(await campaigns.draftInput(W, id, "first")).input as DraftInput & { request: string };
  expect(input.request).toContain('Include the link to "Launch page" written exactly as {{steps.page.url}}.');

  script(() => anthropicTool("propose", email("Hi {{firstName}}, see {{steps.other.url}}.")));
  expect((await run(input)).proposals).toMatchObject([{ rejectionCode: "unknown_merge_field" }]);
  script(() => anthropicTool("propose", email("Hi {{firstName}}, see {{steps.page.url}}.")));
  expect((await run(input)).proposals).toMatchObject([{ rejectionCode: null }]);
  const step = (await campaigns.campaign(W, id))!.steps.find((s) => s.key === "first")!;
  expect(step).toMatchObject({ template: { text: "Hi {{firstName}}, see {{steps.page.url}}." } });
});

test("a newer template isn't overwritten by a run started before it", async () => {
  const { id, input } = await ready();
  script(() => anthropicTool("propose", email("First.")));
  await run(input);
  script(() => anthropicTool("propose", email("Second, from the old revision.")));
  expect((await run(input)).proposals).toMatchObject([{ rejectionCode: "target_changed", offer: "open", targetKind: "step", targetId: id, targetStepKey: "first", body: email("Second, from the old revision.") }]);
  expect(await templateOf(id)).toMatchObject({ templateRevision: 1, template: { text: "First." } });
});

test("a person who uses a kept template is named as who saved it", async () => {
  const { id, input } = await ready();
  script(() => anthropicTool("propose", email("First.")));
  await run(input);
  script(() => anthropicTool("propose", email("Kept for later.")));
  await run(input);
  const saved: { userId: string | null; revision: number }[] = [];
  const offers = createOffers({ sinks: campaignSinks({ facts, onTemplateSaved: async (_w, e) => void saved.push(e) }), now });
  const target = { targetKind: "step" as const, targetId: id, targetStepKey: "first" };
  const offer = (await offers.read(W, target))!;
  expect(await offers.use(W, offer, 1, person.userId)).toEqual({ ok: true });
  expect(await templateOf(id)).toMatchObject({ templateRevision: 2, template: { text: "Kept for later." } });
  expect(saved).toEqual([expect.objectContaining({ userId: person.userId, revision: 2 })]);
  expect(await offers.read(W, target)).toBeNull();
});

test("the same run handing its proposal over twice writes once", async () => {
  const { id, input } = await ready();
  const { draft } = campaignSinks({ facts });
  const proposal = { kind: "draft" as const, outputKey: "template", body: email("Once.") };
  const context = { runId: crypto.randomUUID(), input, tainted: false, pagesRead: [], pages: [], producer: { agent: "test", definitionVersion: 1, promptDigest: "d", routeHash: "r" } };
  expect(await draft(W, proposal, context)).toEqual({ ok: true, itemId: null });
  expect(await draft(W, proposal, context)).toEqual({ ok: true, itemId: null });
  expect((await templateOf(id)).templateRevision).toBe(1);
});

test("a number with no source warns, and a cited current one passes", async () => {
  const subject = crypto.randomUUID();
  const fact = ok(await facts.set(W, { field: "claim", subject, value: "Used by 200 teams", source: me, confidence: "high", actor: person }));

  const uncited = await ready();
  script(() => anthropicTool("propose", email("Used by 200 teams.")));
  await run(uncited.input);
  expect((await templateOf(uncited.id)).template).toMatchObject({ warnings: [{ code: "uncited_number", text: 'A number with no source: "200"' }], needsDecision: [] });

  const cited = await ready();
  script(() => anthropicTool("propose", email("Used by 200 teams.", [{ factId: fact.id, version: fact.version }])));
  await run(cited.input);
  expect((await templateOf(cited.id)).template).toMatchObject({ warnings: [], needsDecision: [] });

  const stale = await ready();
  script(() => anthropicTool("propose", email("Used by 200 teams.", [{ factId: fact.id, version: fact.version + 7 }])));
  await run(stale.input);
  expect((await templateOf(stale.id)).template).toMatchObject({ citations: [], warnings: [{ code: "uncited_number", text: 'A number with no source: "200"' }] });
});

test("a price no Fact holds needs a decision, and the Fact's own price doesn't", async () => {
  const subject = crypto.randomUUID();
  const fact = ok(await facts.set(W, { field: "price", subject, value: "$4,500", source: me, confidence: "high", actor: person }));

  const wrong = await ready();
  script(() => anthropicTool("propose", email("It costs $3,900.")));
  await run(wrong.input);
  expect((await templateOf(wrong.id)).template!.needsDecision).toEqual([{ code: "price_conflict", text: 'No price Fact says "$3,900"' }]);

  const right = await ready();
  script(() => anthropicTool("propose", email("It costs $4,500.", [{ factId: fact.id, version: fact.version }])));
  await run(right.input);
  expect((await templateOf(right.id)).template).toMatchObject({ needsDecision: [] });
});

test("a banned claim warns", async () => {
  const subject = crypto.randomUUID();
  ok(await facts.set(W, { field: "never_say", subject, value: "guaranteed results", source: me, confidence: "high", actor: person }));
  const { id, input } = await ready();
  script(() => anthropicTool("propose", email("We promise guaranteed results.")));
  await run(input);
  expect((await templateOf(id)).template!.warnings.map((w) => w.text).join()).toContain("banned claim");
});

test("once something is written the mode is locked", async () => {
  const { id, input } = await ready();
  ok(await campaigns.setDraftingMode(W, id, "per_person"));
  ok(await campaigns.setDraftingMode(W, id, "template"));
  script(() => anthropicTool("propose", email("Written.")));
  await run(input);
  expect(await campaigns.setDraftingMode(W, id, "per_person")).toEqual({ ok: false, reason: "drafting_mode_locked" });
});
