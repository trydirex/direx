// SPDX-License-Identifier: AGPL-3.0-only
// A draft may rest a target or a channel on an earlier Campaign's reading. The sinks keep that only
// while the reading is this Workspace's, on another plan, and still the newest for its Measure.
import { citedReadings } from "./application/plans";
import { inWorkspace } from "./adapters/repo";
import { expect, test, vi } from "vitest";
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

async function approveStrategy(ws: string, body = strategyDraft()) {
  const { draftRevision } = await plans.strategy(ws);
  const { revision } = ok(await plans.saveStrategyDraft(ws, { revision: draftRevision, body }));
  const { item } = ok(await plans.submitStrategy(ws, { revision, actor }));
  ok(await items.approve(ws, item.id, item.revision, who));
}

async function approvedPlan(ws: string, body = planDraft()) {
  const p = await plans.createPlan(ws, { title: "Earlier", request: "Book 4 meetings", createdBy: person.userId });
  const { revision } = ok(await plans.savePlanDraft(ws, p.id, { revision: 0, body }));
  const { item } = ok(await plans.submitPlan(ws, p.id, { revision, actor }));
  ok(await items.approve(ws, item.id, item.revision, who));
  return p.id;
}

/** Records a reading and returns its id, the newest row the plan has. */
async function reading(ws: string, planId: string, value: string, observedOn: string, o: { measureKey?: string; actor?: { userId: string } } = {}) {
  ok(await plans.recordReading(ws, planId, { measureKey: o.measureKey ?? "meetings", value, observedOn, actor: o.actor ?? { system: "reports" } }));
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

// The views: what each cited reading says, and a note once a newer reading replaces one the version cites.
const measure = (key: string, label: string, basis: Basis = { kind: "assumption" }) => ({ key, label, target: "4", basis });
const twoMeasures = (meetings: Basis = { kind: "assumption" }, replies: Basis = { kind: "assumption" }) => ({ ...planDraft(), measures: [measure("meetings", "Meetings", meetings), measure("replies", "Replies", replies)] });
const shown = (id: string, value: string, observedOn: string, o: { source?: "person" | "system"; newer?: boolean } = {}) =>
  ({ id, found: true, measureLabel: "Meetings", value, source: o.source ?? "system", observedOn, newer: o.newer ?? false });
const missing = (id: string) => ({ id, found: false, measureLabel: null, value: null, source: null, observedOn: null, newer: false });

/** A plan with two Measures and one reading, and an approved plan citing that reading. */
async function citing(ws = W) {
  const source = await approvedPlan(ws, twoMeasures());
  const cited = await reading(ws, source, "3", "2026-11-12");
  return { source, cited, plan: await approvedPlan(ws, planDraft(cite(cited))) };
}

test("a plan view shows the reading it cites; a person's correction adds a note, another Measure's reading doesn't", async () => {
  const { source, cited, plan } = await citing();
  expect(await plans.plan(W, plan)).toMatchObject({ citedReadings: [shown(cited, "3", "2026-11-12")], notes: [] });
  await reading(W, source, "40", "2026-11-13", { measureKey: "replies" });
  expect(await plans.plan(W, plan)).toMatchObject({ citedReadings: [shown(cited, "3", "2026-11-12")], notes: [] });
  await reading(W, source, "2", "2026-11-12", { actor });
  expect(await plans.plan(W, plan)).toMatchObject({ citedReadings: [shown(cited, "3", "2026-11-12", { newer: true })], notes: [{ kind: "reading_changed", readingId: cited }] });
});

test("a new count for the cited Measure adds the note too", async () => {
  const { source, cited, plan } = await citing();
  await reading(W, source, "5", "2026-11-14");
  expect((await plans.plan(W, plan))!.notes).toEqual([{ kind: "reading_changed", readingId: cited }]);
});

test("an id from another Workspace, unknown, or not an id shows as not found, with no note", async () => {
  const W2 = crypto.randomUUID();
  await seedMember(W2, person.userId);
  await approveStrategy(W2);
  const theirs = await reading(W2, await approvedPlan(W2), "9", "2026-11-12");
  const unknown = crypto.randomUUID();
  const plan = await approvedPlan(W, twoMeasures(cite(theirs), cite(unknown)));
  const { draftRevision } = (await plans.plan(W, plan))!;
  ok(await plans.savePlanDraft(W, plan, { revision: draftRevision, body: { measures: [{ basis: cite("typed-by-hand") }, null] } }));
  expect(await plans.plan(W, plan)).toMatchObject({ citedReadings: [missing(theirs), missing(unknown), missing("typed-by-hand")], notes: [] });
});

test("a reading only the draft cites is shown but never noted", async () => {
  const { source, cited, plan } = await citing();
  const older = await reading(W, source, "1", "2026-11-05");
  const { draftRevision } = (await plans.plan(W, plan))!;
  ok(await plans.savePlanDraft(W, plan, { revision: draftRevision, body: twoMeasures(cite(older), cite(cited)) }));
  expect(await plans.plan(W, plan)).toMatchObject({ citedReadings: [shown(cited, "3", "2026-11-12"), shown(older, "1", "2026-11-05", { newer: true })], notes: [] });
});

test("the Strategy view shows its cited readings and notes one a newer reading replaced", async () => {
  const W3 = crypto.randomUUID();
  await seedMember(W3, person.userId);
  expect(await plans.strategy(W3)).toMatchObject({ notes: [], citedReadings: [] });
  await approveStrategy(W3);
  const { source, cited } = await citing(W3);
  const channel = (basis: Basis) => ({ key: "email", label: "Cold email", timing: "now" as const, reason: "Replies came from it", basis });
  await approveStrategy(W3, strategyDraft([channel(cite(cited))]));
  expect(await plans.strategy(W3)).toMatchObject({ citedReadings: [shown(cited, "3", "2026-11-12")], notes: [] });
  const correction = await reading(W3, source, "2", "2026-11-12", { actor });
  const s = await plans.strategy(W3);
  ok(await plans.saveStrategyDraft(W3, { revision: s.draftRevision, body: strategyDraft([channel(cite(correction))]) }));
  expect(await plans.strategy(W3)).toMatchObject({
    citedReadings: [shown(cited, "3", "2026-11-12", { newer: true }), shown(correction, "2", "2026-11-12", { source: "person" })],
    notes: [{ kind: "reading_changed", readingId: cited }],
  });
});


test("a thousand draft citations use one query, preserving order and deduplicating", async () => {
  const { cited } = await citing();
  const ids = [cited.toUpperCase(), ...Array.from({ length: 1000 }, () => crypto.randomUUID()), cited];
  await inWorkspace(W, async (tx) => {
    const spy = vi.spyOn(tx, "select");
    try {
      const result = await citedReadings(tx, [...ids, cited, "bad-id"]);
      expect(result).toEqual([shown(ids[0]!, "3", "2026-11-12"), ...ids.slice(1, -1).map(missing), shown(cited, "3", "2026-11-12"), missing("bad-id")]);
      // One outer SELECT and its NOT EXISTS subquery, independent of citation count.
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});

test("empty and invalid citations need no reading query", async () => {
  expect(await inWorkspace(W, (tx) => citedReadings(tx, []))).toEqual([]);
  expect(await inWorkspace(W, (tx) => citedReadings(tx, ["bad-id", "bad-id"])) ).toEqual([missing("bad-id")]);
});

test("cited labels follow the approved plan and fall back to the key if removed", async () => {
  const { source, cited } = await citing();
  const replace = async (body: PlanBody) => {
    const p = (await plans.plan(W, source))!;
    const { revision } = ok(await plans.savePlanDraft(W, source, { revision: p.draftRevision, body }));
    const { item } = ok(await plans.submitPlan(W, source, { revision, actor }));
    ok(await items.approve(W, item.id, item.revision, who));
  };
  await replace({ ...planDraft(), measures: [measure("meetings", "New label")] });
  expect(await inWorkspace(W, (tx) => citedReadings(tx, [cited]))).toEqual([{ ...shown(cited, "3", "2026-11-12"), measureLabel: "New label" }]);
  await replace({ ...planDraft(), measures: [measure("replies", "Replies")] });
  expect(await inWorkspace(W, (tx) => citedReadings(tx, [cited]))).toEqual([{ ...shown(cited, "3", "2026-11-12"), measureLabel: "meetings" }]);
});
