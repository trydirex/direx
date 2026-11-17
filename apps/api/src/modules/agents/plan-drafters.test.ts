// SPDX-License-Identifier: AGPL-3.0-only
// A drafting run from a person's sentence to an editable draft, through the real loop, models, facts
// and items. Only the provider is local.
import type { PgBoss } from "pg-boss";
import { afterAll, expect, test } from "vitest";
import * as repo from "./adapters/repo";
import { createLoop } from "./application/loop";
import { createOffers } from "./application/offers";
import { createProposals, type SinkContext } from "./application/proposals";
import { createRuns } from "./application/runs";
import { checkEvals, type DraftInput } from "./index";
import { brokenInvariants } from "./domain/invariants";
import { createFacts, factKinds } from "../facts/index";
import { itemsWorld, person } from "../items/fixtures/items";
import { createModels, routesFor } from "../models/index";
import { anthropicText, anthropicTool, fakeProvider, testKeys, type Received } from "../models/fixtures/provider";
import { createPlans, planDefinitions, planDrafter, planKinds, planSinks, strategyDrafter, type Basis, type PlanBody, type StrategyBody } from "../plans/index";
import { campaignOnPlanCreated } from "../campaigns/index";
import { planEvalSuites } from "../plans/evals";

const fake = fakeProvider();
afterAll(() => fake.stop());

const { W, items, who } = await itemsWorld({ kinds: { ...factKinds(), ...planKinds() } });
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const me = { kind: "person" as const, label: "Sam" };
const actor = { userId: person.userId };
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};

const now = () => new Date();
const runs = createRuns({ boss: { send: async () => {} } as unknown as PgBoss, now, notify: async () => {}, warnItem: async () => {} });
const models = createModels({ deployment: "self_host", keys: testKeys("sk-test"), baseURLs: { anthropic: fake.url }, runGate: runs.runGate, now });
const realSinks = planSinks({ facts });
let sinks = realSinks;
const accept = createProposals({ definitions: planDefinitions, sinks: { strategy_proposal: (...a) => sinks.strategy_proposal(...a), plan_proposal: (...a) => sinks.plan_proposal(...a) }, warnItem: async () => {}, now });
const fetchPage = async () => {
  throw new Error("a drafter has no pages to read");
};
const loop = createLoop({ models, runs, fetchPage, now, definitions: planDefinitions, context: async () => [], accept });

const strategyDraft = (o: Partial<StrategyBody> = {}): StrategyBody => ({
  schemaVersion: 1,
  whoFor: "Heads of ecommerce ops",
  personas: [{ name: "Ops lead" }],
  positioning: "The audit that finds the error",
  channels: [{ key: "email", label: "Cold email", timing: "now", reason: "Ops leads read email", basis: { kind: "assumption" } }],
  assumptions: [{ text: "Which opening line works" }],
  ...o,
});
const planDraft = (basis: Basis = { kind: "assumption" }): PlanBody => ({
  schemaVersion: 1,
  goal: "4 meetings",
  audience: "Shopify ops leads",
  startsOn: "2026-11-02",
  endsOn: "2026-11-30",
  steps: [{ key: "first", on: "2026-11-03", channelKey: "email", title: "First email" }],
  measures: [{ key: "meetings", label: "Meetings", target: "4", basis }],
  budget: [],
  assumptions: [],
});

let received: Received[] = [];
const script = (...steps: (() => Response)[]) => {
  let i = 0;
  received = [];
  fake.respondWith((r) => {
    received.push(r);
    return steps[Math.min(i++, steps.length - 1)]!();
  });
};
const run = async (definition: typeof strategyDrafter | typeof planDrafter, input: DraftInput) => {
  const started = await runs.start(W, { definition, input, idempotencyKey: crypto.randomUUID(), trigger: "person" });
  await loop.execute((await runs.wake({ workspaceId: W, runId: started.id }))!);
  return repo.inWorkspace(W, async (tx) => ({ run: (await repo.readRun(tx, started.id))!, parts: await repo.partsOf(tx, started.id), events: await repo.eventsOf(tx, started.id), proposals: await repo.proposalsOf(tx, started.id) }));
};
const count = async (kind: string) => (await items.list(W, { state: "needs_approval", limit: 200, offset: 0 })).items.filter((i) => i.kind === kind).length;

// The Strategy comes first: every plan run below needs one approved.
test("a Strategy run fills the draft, with no Item and no version, and is recorded", async () => {
  script(() => anthropicTool("propose", strategyDraft()));
  const r = await run(strategyDrafter, await plans.strategyDraftInput(W, "We sell audits to Shopify brands"));
  expect(r.run.status).toBe("succeeded");
  expect(r.run.tainted).toBe(false);
  const s = await plans.strategy(W);
  expect(s.draft).toMatchObject({ positioning: "The audit that finds the error" });
  expect(s.draftRevision).toBe(1);
  expect(s.currentVersion).toBeNull();
  expect(s.waiting).toBeNull();
  expect(await plans.strategyVersions(W)).toEqual([]);
  expect(r.proposals).toMatchObject([{ kind: "strategy_proposal", itemId: null, rejectionCode: null }]);
  expect(r.parts.map((p) => p.kind)).toEqual(["definition", "date", "citable_facts", "request"]);
  // A person's words don't stay on the run once it ends, and neither they nor the brief are in the record.
  expect(JSON.stringify(r.run.input)).not.toContain("audits to Shopify");
  expect(JSON.stringify([r.parts, r.events])).not.toContain("audits to Shopify");
});

test("a person then submits and approves that draft, the only way it becomes current", async () => {
  const s = await plans.strategy(W);
  const submitted = ok(await plans.submitStrategy(W, { revision: s.draftRevision, actor }));
  ok(await items.approve(W, submitted.item.id, submitted.item.revision, who));
  expect((await plans.strategy(W)).currentVersion).toBe(1);
});

const newPlanWith = async (request: string) => {
  const p = await plans.createPlan(W, { title: "Q4", request, createdBy: person.userId });
  const asked = await plans.planDraftInput(W, p.id);
  return { id: p.id, input: ok(asked).input };
};

test("a plan run sees the Strategy and the request, offers no tool but propose, and makes no Item", async () => {
  const before = await count("plan_version");
  const { id, input } = await newPlanWith("Book 4 demos");
  script(() => anthropicTool("propose", planDraft()));
  const r = await run(planDrafter, input);
  expect(r.run.status).toBe("succeeded");
  const body = JSON.stringify(received[0]!.body);
  expect(body).toContain("Book 4 demos");
  expect(body).toContain("The audit that finds the error");
  expect((received[0]!.body as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(["propose"]);

  const p = (await plans.plan(W, id))!;
  expect(p.draft).toMatchObject({ goal: "4 meetings" });
  expect(p.currentVersion).toBeNull();
  expect(await plans.planVersions(W, id)).toEqual([]);
  expect(await count("plan_version")).toBe(before);
  expect(r.parts.find((x) => x.kind === "strategy")).toMatchObject({ version: "1", trust: "trusted" });
});

test("a Fact citation that holds stays, and an invented or stale one becomes an assumption", async () => {
  const subject = crypto.randomUUID();
  const fact = ok(await facts.set(W, { field: "price", subject, value: "$4,500", source: me, confidence: "high", actor: person }));

  const held = await newPlanWith("a");
  expect(held.input.brief.find((b) => b.kind === "citable_facts")!.text).toContain(fact.id);
  script(() => anthropicTool("propose", planDraft({ kind: "fact", factId: fact.id, version: fact.version })));
  await run(planDrafter, held.input);
  expect(((await plans.plan(W, held.id))!.draft as PlanBody).measures[0]!.basis).toEqual({ kind: "fact", factId: fact.id, version: fact.version });

  const invented = await newPlanWith("b");
  script(() => anthropicTool("propose", planDraft({ kind: "fact", factId: crypto.randomUUID(), version: 1 })));
  await run(planDrafter, invented.input);
  expect(((await plans.plan(W, invented.id))!.draft as PlanBody).measures[0]!.basis).toEqual({ kind: "assumption" });

  const stale = await newPlanWith("c");
  script(() => anthropicTool("propose", planDraft({ kind: "fact", factId: fact.id, version: fact.version + 7 })));
  await run(planDrafter, stale.input);
  expect(((await plans.plan(W, stale.id))!.draft as PlanBody).measures[0]!.basis).toEqual({ kind: "assumption" });
});

test("invalid output changes nothing and records why, and free text makes nothing", async () => {
  const bad = await newPlanWith("d");
  script(() => anthropicTool("propose", { ...planDraft(), measures: [{ key: "m", label: "m", target: "4" }] }));
  const r = await run(planDrafter, bad.input);
  expect(r.run).toMatchObject({ status: "failed", statusReason: "invalid_output" });
  expect(r.events.some((e) => e.kind === "rejection" && e.outcome === "invalid_output")).toBe(true);
  expect((await plans.plan(W, bad.id))!.draftRevision).toBe(0);

  const talk = await newPlanWith("e");
  script(() => anthropicText("Here is your plan: send emails."));
  expect((await run(planDrafter, talk.input)).run).toMatchObject({ status: "failed", statusReason: "free_text" });
  expect((await plans.plan(W, talk.id))!.draft).toBeNull();
});

test("a person's save during the run isn't overwritten", async () => {
  const { id, input } = await newPlanWith("f");
  ok(await plans.savePlanDraft(W, id, { revision: 0, body: { goal: "Mine" } }));
  script(() => anthropicTool("propose", planDraft()));
  const r = await run(planDrafter, input);
  expect(r.run.status).toBe("succeeded");
  expect(r.proposals).toMatchObject([{ rejectionCode: "target_changed", offer: "open", targetKind: "plan", targetId: id, targetStepKey: null, body: planDraft() }]);
  expect((await plans.plan(W, id))!.draft).toEqual({ goal: "Mine" });

  // A second stale run for the same plan replaces the first offer.
  script(() => anthropicTool("propose", planDraft()));
  const again = await run(planDrafter, input);
  expect(again.proposals).toMatchObject([{ offer: "open" }]);
  expect((await repo.inWorkspace(W, (tx) => repo.proposalsOf(tx, r.run.id)))[0]).toMatchObject({ offer: "replaced" });
});

const offers = createOffers({ sinks: { strategy_proposal: (...a) => sinks.strategy_proposal(...a), plan_proposal: (...a) => sinks.plan_proposal(...a) }, now });
const staleOffer = async (request: string, basis?: Basis) => {
  const { id, input } = await newPlanWith(request);
  ok(await plans.savePlanDraft(W, id, { revision: 0, body: { goal: "Mine" } }));
  script(() => anthropicTool("propose", planDraft(basis)));
  await run(planDrafter, input);
  const offer = (await offers.read(W, { targetKind: "plan", targetId: id, targetStepKey: null }))!;
  return { id, key: { runId: offer.runId, outputKey: offer.outputKey }, offer };
};

test("a kept draft is used only by a person's click, against the revision they see, and only once", async () => {
  const { id, key, offer } = await staleOffer("o1");
  expect(offer).toMatchObject({ kind: "plan_proposal", body: planDraft() });

  expect(await offers.use(W, key, 0, person.userId)).toEqual({ ok: false, code: "target_changed" });
  expect((await plans.plan(W, id))!.draft).toEqual({ goal: "Mine" });
  expect(await offers.read(W, { targetKind: "plan", targetId: id, targetStepKey: null })).not.toBeNull();

  expect(await offers.use(W, key, 1, person.userId)).toEqual({ ok: true });
  expect((await plans.plan(W, id))!).toMatchObject({ draftRevision: 2, draft: { goal: "4 meetings" } });
  expect(await offers.use(W, key, 2, person.userId)).toEqual({ ok: false, code: "offer_closed" });
  expect((await plans.plan(W, id))!.draftRevision).toBe(2);
  const [row] = await repo.inWorkspace(W, (tx) => repo.proposalsOf(tx, key.runId));
  expect(row).toMatchObject({ offer: "used", offerBy: person.userId });
});

test("two clicks at once move the draft once", async () => {
  const { id, key } = await staleOffer("o2");
  // The second lands on the sink's "this run already wrote it", so it changes nothing.
  await Promise.all([offers.use(W, key, 1, person.userId), offers.use(W, key, 1, person.userId)]);
  expect((await plans.plan(W, id))!).toMatchObject({ draftRevision: 2, draft: { goal: "4 meetings" } });
});

test("using a kept draft runs the sink's checks again, with the run's own trust", async () => {
  const subject = crypto.randomUUID();
  const fact = ok(await facts.set(W, { field: "price", subject, value: "$4,500", source: me, confidence: "high", actor: person }));
  const { id, key } = await staleOffer("o3", { kind: "fact", factId: fact.id, version: fact.version });
  ok(await facts.set(W, { field: "price", subject, value: "$5,000", source: me, confidence: "high", actor: person }));

  const seen: SinkContext[] = [];
  sinks = { ...realSinks, plan_proposal: (w, p, c) => (seen.push(c), realSinks.plan_proposal(w, p, c)) };
  try {
    expect(await offers.use(W, key, 1, person.userId)).toEqual({ ok: true });
  } finally {
    sinks = realSinks;
  }
  expect(((await plans.plan(W, id))!.draft as PlanBody).measures[0]!.basis).toEqual({ kind: "assumption" });
  const run = await repo.inWorkspace(W, (tx) => repo.readRun(tx, key.runId));
  expect(seen[0]).toMatchObject({ runId: key.runId, tainted: run!.tainted, userId: person.userId, input: { target: { id, draftRevision: 1 } } });
});

test("dismissing closes the offer and names who; other refusals keep no draft", async () => {
  const { id, key } = await staleOffer("o4");
  expect(await offers.dismiss(W, key, person.userId)).toEqual({ ok: true });
  expect(await offers.dismiss(W, key, person.userId)).toEqual({ ok: false, code: "offer_closed" });
  expect(await offers.read(W, { targetKind: "plan", targetId: id, targetStepKey: null })).toBeNull();
  expect((await repo.inWorkspace(W, (tx) => repo.proposalsOf(tx, key.runId)))[0]).toMatchObject({ offer: "dismissed", offerBy: person.userId });

  const archived = await staleOffer("o5");
  ok(await plans.archivePlan(W, archived.id));
  expect(await offers.use(W, archived.key, 1, person.userId)).toEqual({ ok: false, code: "archived" });
  expect((await repo.inWorkspace(W, (tx) => repo.proposalsOf(tx, archived.key.runId)))[0]).toMatchObject({ offer: "dismissed" });

  const { input } = await newPlanWith("o6");
  const planId = (input.target as { id: string }).id;
  ok(await plans.archivePlan(W, planId));
  script(() => anthropicTool("propose", planDraft()));
  expect((await run(planDrafter, input)).proposals).toMatchObject([{ rejectionCode: "archived", offer: null, body: null }]);
});

test("handing over twice writes the draft once", async () => {
  const { id, input } = await newPlanWith("g");
  const started = await runs.start(W, { definition: planDrafter, input, idempotencyKey: crypto.randomUUID(), trigger: "person" });
  const proposal = { kind: "plan_proposal" as const, outputKey: "plan", body: planDraft() };
  const context = { runId: started.id, input, tainted: false, pagesRead: [], pages: [], producer: { agent: "test", definitionVersion: 1, promptDigest: "d", routeHash: "r" } };
  expect(await sinks.plan_proposal(W, proposal, context)).toEqual({ ok: true, itemId: null });
  expect(await sinks.plan_proposal(W, proposal, context)).toEqual({ ok: true, itemId: null });
  expect((await plans.plan(W, id))!.draftRevision).toBe(1);
});

test("an archived plan takes no draft, whether asked before or after the run", async () => {
  const { id, input } = await newPlanWith("h");
  ok(await plans.archivePlan(W, id));
  expect(await plans.planDraftInput(W, id)).toEqual({ ok: false, reason: "archived" });
  script(() => anthropicTool("propose", planDraft()));
  expect((await run(planDrafter, input)).proposals).toMatchObject([{ rejectionCode: "archived" }]);
});

test("neither definition has a tool, and both draft on a route only self-host has", () => {
  expect(strategyDrafter.tools).toEqual([]);
  expect(planDrafter.tools).toEqual([]);
  expect(routesFor("self_host").plan_draft).toBeDefined();
  expect(routesFor("cloud").plan_draft).toBeUndefined();
});

test("the eval gate covers both, and each invariant really breaks", () => {
  const routes = { cloud: routesFor("cloud"), self_host: routesFor("self_host") };
  expect(checkEvals({ suites: planEvalSuites, routes })).toEqual([]);
  for (const s of planEvalSuites) {
    for (const c of s.cases) expect(brokenInvariants(s.transcribe(c, s.read)), `${s.agent.id}: ${c.name}`).toEqual(c.breaks ? [c.breaks] : []);
  }
  const cloud = { ...routes.cloud, plan_draft: routes.self_host.plan_draft! };
  expect(checkEvals({ suites: planEvalSuites, routes: { ...routes, cloud } }).join()).toContain("strategy_drafter v1 (plan_draft) on cloud");
});
