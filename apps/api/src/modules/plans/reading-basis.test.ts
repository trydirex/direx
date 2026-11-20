// SPDX-License-Identifier: AGPL-3.0-only
// A draft may rest a target or a channel on an earlier Campaign's reading. The sinks keep that only
// while the reading is this Workspace's, on another plan, and still the newest for its Measure.
import { expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createFacts, factKinds } from "../facts/index";
import { seedMember } from "../identity/fixtures/member";
import { itemsWorld, person } from "../items/fixtures/items";
import { createPlans, planKinds, planSinks, type Basis, type PlanBody, type StrategyBody } from "./index";
import { campaignOnPlanCreated } from "../campaigns/index";

const { W, items, who } = await itemsWorld({ kinds: { ...factKinds(), ...planKinds() } });
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const sinks = planSinks({ facts });
const actor = { userId: person.userId };
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};

const strategyDraft = (channels: StrategyBody["channels"] = [{ key: "email", label: "Cold email", timing: "now", reason: "Ops leads read email", basis: { kind: "assumption" } }]): StrategyBody => ({
  schemaVersion: 1,
  whoFor: "Heads of ecommerce ops",
  personas: [],
  positioning: "The audit that finds the error",
  channels,
  assumptions: [],
});
const planDraft = (basis: Basis = { kind: "assumption" }): PlanBody => ({
  schemaVersion: 1,
  goal: "4 meetings",
  audience: "Shopify ops leads",
  startsOn: "2026-11-01",
  endsOn: "2026-11-30",
  steps: [{ key: "first", on: "2026-11-03", channelKey: "email", title: "First email" }],
  measures: [{ key: "meetings", label: "Meetings", target: "4", basis, source: "meetings" }],
  budget: [],
  assumptions: [],
});

async function approveStrategy(ws: string) {
  const { draftRevision } = await plans.strategy(ws);
  const { revision } = ok(await plans.saveStrategyDraft(ws, { revision: draftRevision, body: strategyDraft() }));
  const { item } = ok(await plans.submitStrategy(ws, { revision, actor }));
  ok(await items.approve(ws, item.id, item.revision, who));
}

async function approvedPlan(ws: string) {
  const p = await plans.createPlan(ws, { title: "Earlier", request: "Book 4 meetings", createdBy: person.userId });
  const { revision } = ok(await plans.savePlanDraft(ws, p.id, { revision: 0, body: planDraft() }));
  const { item } = ok(await plans.submitPlan(ws, p.id, { revision, actor }));
  ok(await items.approve(ws, item.id, item.revision, who));
  return p.id;
}

/** Records a reading and returns its id, the newest row the plan has. */
async function reading(ws: string, planId: string, value: string, observedOn: string) {
  ok(await plans.recordReading(ws, planId, { measureKey: "meetings", value, observedOn, actor: { system: "reports" } }));
  const c = await appClient();
  await c.query("select set_config('app.workspace_id', $1, false)", [ws]);
  const { rows } = await c.query("select id from plan_measure_readings where plan_id = $1 order by at desc limit 1", [planId]);
  await c.end();
  return rows[0].id as string;
}

const context = (target: { id: string | null; draftRevision: number }) => ({
  runId: crypto.randomUUID(),
  input: { request: "Draft it", brief: [], target },
  tainted: false,
  pagesRead: [],
  pages: [],
  producer: { agent: "test", definitionVersion: 1, promptDigest: "d", routeHash: "r" },
});

/** The basis a plan draft keeps once the sink has checked it. A new plan is drafted unless one is named. */
async function planSinkKeeps(basis: Basis, planId?: string) {
  const id = planId ?? (await plans.createPlan(W, { title: "Next", request: "Book 6 meetings", createdBy: person.userId })).id;
  const { draftRevision } = (await plans.plan(W, id))!;
  ok(await sinks.plan_proposal(W, { kind: "plan_proposal", outputKey: "plan", body: planDraft(basis) }, context({ id, draftRevision })));
  return ((await plans.plan(W, id))!.draft as PlanBody).measures[0]!.basis;
}

await approveStrategy(W);
const earlier = await approvedPlan(W);
const counted = await reading(W, earlier, "3", "2026-11-12");
const cite = (readingId: string): Basis => ({ kind: "reading", readingId });

test("a newest reading from another plan in this Workspace survives the plan sink", async () => {
  expect(await planSinkKeeps(cite(counted))).toEqual(cite(counted));
});

test("a reading from another Workspace arrives as an assumption", async () => {
  const W2 = crypto.randomUUID();
  await seedMember(W2, person.userId);
  await approveStrategy(W2);
  const theirs = await reading(W2, await approvedPlan(W2), "9", "2026-11-12");
  expect(await planSinkKeeps(cite(theirs))).toEqual({ kind: "assumption" });
  expect(await planSinkKeeps(cite(crypto.randomUUID()))).toEqual({ kind: "assumption" });
});

test("a plan can't rest on its own reading", async () => {
  const own = await approvedPlan(W);
  const id = await reading(W, own, "2", "2026-11-12");
  expect(await planSinkKeeps(cite(id), own)).toEqual({ kind: "assumption" });
  expect(await planSinkKeeps(cite(id), own.toUpperCase())).toEqual({ kind: "assumption" });
});

test("a reading stops standing once a later day, or a later write for its day, is recorded", async () => {
  const plan = await approvedPlan(W);
  const first = await reading(W, plan, "3", "2026-11-12");
  // An earlier day typed later doesn't replace it, as tracking orders them.
  await reading(W, plan, "1", "2026-11-05");
  expect(await planSinkKeeps(cite(first))).toEqual(cite(first));
  await reading(W, plan, "4", "2026-11-12");
  expect(await planSinkKeeps(cite(first))).toEqual({ kind: "assumption" });
});

test("the Strategy sink keeps a newest reading from any plan and downgrades a stale one", async () => {
  const plan = await approvedPlan(W);
  const stale = await reading(W, plan, "3", "2026-11-12");
  const newest = await reading(W, plan, "5", "2026-11-13");
  const channel = (key: string, basis: Basis) => ({ key, label: key, timing: "now" as const, reason: "Replies came from it", basis });
  const s = await plans.strategy(W);
  ok(await sinks.strategy_proposal(W, { kind: "strategy_proposal", outputKey: "strategy", body: strategyDraft([channel("email", cite(newest)), channel("dm", cite(stale))]) }, context({ id: s.id, draftRevision: s.draftRevision })));
  expect(((await plans.strategy(W)).draft as StrategyBody).channels.map((c) => c.basis)).toEqual([cite(newest), { kind: "assumption" }]);
});
