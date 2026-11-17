// SPDX-License-Identifier: AGPL-3.0-only
// Strategy, plans and tracking through the module's entry point, with real Facts and real Items.
import { expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createFacts, factKinds } from "../facts/index";
import { itemsWorld, person } from "../items/fixtures/items";
import { createPlans, planKinds, type PlanBody, type StrategyBody } from "./index";
import { campaignOnPlanCreated } from "../campaigns/index";

let onApproved: () => Promise<void> = async () => {};
const world = await itemsWorld({ kinds: { ...factKinds(), ...planKinds({ onPlanApproved: () => onApproved() }) } });
const { W, items, who } = world;
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const me = { kind: "person" as const, label: "Sam" };
const actor = { userId: person.userId };
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};

const strategyDraft = (over: Partial<StrategyBody> = {}): StrategyBody => ({
  schemaVersion: 1,
  whoFor: "Heads of ecommerce ops",
  personas: [],
  positioning: "The audit that finds the error",
  channels: [{ key: "email", label: "Cold email", timing: "now", reason: "Ops leads read email", basis: { kind: "assumption" } }],
  assumptions: [],
  ...over,
});
const planDraft = (over: Partial<PlanBody> = {}): PlanBody => ({
  schemaVersion: 1,
  goal: "4 meetings",
  audience: "Shopify ops leads",
  startsOn: "2026-11-01",
  endsOn: "2026-11-30",
  steps: [{ key: "first", on: "2026-11-03", channelKey: "email", title: "First email" }],
  measures: [{ key: "meetings", label: "Meetings", target: "4", basis: { kind: "assumption" } }],
  budget: [{ label: "Mailbox", amountCents: null, currency: "USD", billedBy: "your_account" }],
  assumptions: [{ text: "Which opening line works" }],
  ...over,
});

async function submitStrategy(body: StrategyBody) {
  const { draftRevision } = await plans.strategy(W);
  const { revision } = ok(await plans.saveStrategyDraft(W, { revision: draftRevision, body }));
  return ok(await plans.submitStrategy(W, { revision, actor }));
}
async function approve(item: { id: string; revision: number }) {
  return items.approve(W, item.id, item.revision, who);
}
async function newPlan(body: PlanBody = planDraft()) {
  const p = await plans.createPlan(W, { title: "Q4", request: "Book 4 meetings", createdBy: person.userId });
  const saved = ok(await plans.savePlanDraft(W, p.id, { revision: 0, body }));
  return { id: p.id, revision: saved.revision };
}
async function approvedPlan(body: PlanBody = planDraft()) {
  const p = await newPlan(body);
  const s = ok(await plans.submitPlan(W, p.id, { revision: p.revision, actor }));
  // The Item names its plan, so Home can link straight to it.
  expect(s.item.groupKey).toBe(`plan:${p.id}`);
  ok(await approve(s.item));
  return p.id;
}
const count = async (table: string) => {
  const c = await appClient();
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  const { rows } = await c.query(`select count(*)::int as n from ${table}`);
  await c.end();
  return rows[0].n as number;
};

// Order matters only here: no plan can be submitted until the first Strategy is approved.
test("a plan can't be submitted before there is an approved Strategy", async () => {
  const p = await newPlan();
  expect(await plans.submitPlan(W, p.id, { revision: p.revision, actor })).toEqual({ ok: false, reason: "no_strategy" });
});

test("a partial draft saves and says what's missing; submitting it is refused", async () => {
  const saved = ok(await plans.saveStrategyDraft(W, { revision: 0, body: { whoFor: "x" } }));
  expect(saved.missing.map((m) => m.path)).toContain("positioning");
  expect(await plans.submitStrategy(W, { revision: saved.revision, actor })).toMatchObject({ ok: false, reason: "incomplete" });
  expect(await plans.saveStrategyDraft(W, { revision: 0, body: {} })).toEqual({ ok: false, reason: "stale_revision" });
});

test("submitting writes a version and one Item, and approving makes that version current", async () => {
  const s = await submitStrategy(strategyDraft());
  expect(s.version).toBe(1);
  expect(s.item).toMatchObject({ kind: "strategy_version", state: "needs_approval", clean: false });
  expect((await plans.strategy(W)).currentVersion).toBeNull();

  expect(ok(await approve(s.item)).item.state).toBe("applied");
  const after = await plans.strategy(W);
  expect(after.currentVersion).toBe(1);
  expect(after.current).toMatchObject({ positioning: "The audit that finds the error" });
  expect((await plans.strategyVersions(W))[0]).toMatchObject({ version: 1, baseVersion: null, actorUserId: person.userId });
});

test("a later edit changes only the draft", async () => {
  const before = await plans.strategy(W);
  ok(await plans.saveStrategyDraft(W, { revision: before.draftRevision, body: strategyDraft({ positioning: "Edited" }) }));
  const after = await plans.strategy(W);
  expect(after.current).toEqual(before.current);
  expect(after.draft).toMatchObject({ positioning: "Edited" });
  expect((await plans.strategyVersions(W)).length).toBe(1);
});

test("a newer submit dismisses the older Item, and an old base can't become current", async () => {
  const p = await newPlan();
  const first = ok(await plans.submitPlan(W, p.id, { revision: p.revision, actor }));
  const saved = ok(await plans.savePlanDraft(W, p.id, { revision: p.revision, body: planDraft({ goal: "5 meetings" }) }));
  const second = ok(await plans.submitPlan(W, p.id, { revision: saved.revision, actor }));
  expect((await items.view(W, first.item.id))!.state).toBe("cancelled");
  ok(await approve(second.item));

  // The first version, based on nothing, offered again after the second became current.
  const again = ok(await items.createItem(W, { kind: "plan_version", payload: { targetId: p.id, version: first.version }, actor, details: { title: "old", warnings: [{ code: "unspecified", text: "x" }] } }));
  expect(await approve(again.item)).toMatchObject({ ok: false, reason: "target_changed" });
  expect((await plans.plan(W, p.id))!.currentVersion).toBe(second.version);
});

test("submitting the same words twice makes one Item; once current, it is refused as no change", async () => {
  const p = await newPlan();
  const a = ok(await plans.submitPlan(W, p.id, { revision: p.revision, actor }));
  const b = ok(await plans.submitPlan(W, p.id, { revision: p.revision, actor }));
  expect(b.item.id).toBe(a.item.id);
  expect(b.version).toBe(a.version);
  ok(await approve(a.item));
  expect(await plans.submitPlan(W, p.id, { revision: p.revision, actor })).toEqual({ ok: false, reason: "no_change" });
});

test("two approvals racing from one base leave one current version", async () => {
  const p = await newPlan();
  const one = ok(await plans.submitPlan(W, p.id, { revision: p.revision, actor }));
  const other = ok(await items.createItem(W, { kind: "plan_version", payload: { targetId: p.id, version: one.version }, actor, details: { title: "same", warnings: [{ code: "unspecified", text: "x" }] } }));
  const results = await Promise.all([approve(one.item), approve(other.item)]);
  // Both name one version, so the loser sees its base has moved.
  expect(results.filter((r) => r.ok).length).toBe(1);
  expect(results.find((r) => !r.ok)).toMatchObject({ reason: "target_changed" });
});

test("Approve all clean refuses both kinds", async () => {
  const p = await newPlan();
  const s = ok(await plans.submitPlan(W, p.id, { revision: p.revision, actor }));
  const [r] = await items.approveClean(W, [{ id: s.item.id, revision: s.item.revision }], who);
  expect(r!.result).toMatchObject({ ok: false, reason: "not_clean" });
});

test("if the hook for an approved plan throws, nothing changes", async () => {
  const p = await newPlan();
  const s = ok(await plans.submitPlan(W, p.id, { revision: p.revision, actor }));
  onApproved = async () => {
    throw new Error("boom");
  };
  await expect(approve(s.item)).rejects.toThrow("boom");
  onApproved = async () => {};
  expect((await plans.plan(W, p.id))!.currentVersion).toBeNull();
  expect((await items.view(W, s.item.id))!.state).toBe("needs_approval");
});

test("a version pins the Strategy that was current, and a newer Strategy only shows a note", async () => {
  const id = await approvedPlan();
  expect((await plans.plan(W, id))!.notes).toEqual([]);
  const pinned = (await plans.plan(W, id))!.strategyVersion!;

  const s = await submitStrategy(strategyDraft({ positioning: `Moved ${crypto.randomUUID()}` }));
  ok(await approve(s.item));
  const after = (await plans.plan(W, id))!;
  expect(after.strategyVersion).toBe(pinned);
  expect(after.notes).toEqual([{ kind: "strategy_changed" }]);
  expect(after.currentVersion).toBe(1);
});

test.each([
  ["stale", async (subject: string) => ok(await facts.set(W, { field: "price", subject, value: "$2", source: me, confidence: "high", actor: person }))],
  ["retired", async (_s: string, id: string) => ok(await facts.retire(W, id, person))],
])("approving with a %s citation is refused and names the Fact", async (_name, change) => {
  const subject = crypto.randomUUID();
  const fact = ok(await facts.set(W, { field: "price", subject, value: "$1", source: me, confidence: "high", actor: person }));
  const measures = [{ key: "m", label: "m", target: "1", basis: { kind: "fact" as const, factId: fact.id, version: fact.version } }];
  const p = await newPlan(planDraft({ measures }));
  const s = ok(await plans.submitPlan(W, p.id, { revision: p.revision, actor }));
  await change(subject, fact.id);
  expect(await approve(s.item)).toMatchObject({ ok: false, reason: `citation_not_ok:${fact.id}` });
  expect((await plans.plan(W, p.id))!.currentVersion).toBeNull();
});

test("a contested citation is refused, and a missing one too", async () => {
  const subject = crypto.randomUUID();
  const fact = ok(await facts.set(W, { field: "price", subject, value: "$1", source: me, confidence: "high", actor: person }));
  const cite = (factId: string) => planDraft({ measures: [{ key: "m", label: "m", target: "1", basis: { kind: "fact", factId, version: 1 } }] });

  const contested = await newPlan(cite(fact.id));
  const s = ok(await plans.submitPlan(W, contested.id, { revision: contested.revision, actor }));
  ok(await facts.propose(W, { field: "price", subject, value: "$9", source: me, confidence: "high", actor: person }));
  expect(await approve(s.item)).toMatchObject({ ok: false, reason: `citation_not_ok:${fact.id}` });

  const gone = crypto.randomUUID();
  const missing = await newPlan(cite(gone));
  const m = ok(await plans.submitPlan(W, missing.id, { revision: missing.revision, actor }));
  expect(await approve(m.item)).toMatchObject({ ok: false, reason: `citation_not_ok:${gone}` });
});

test("a current citation passes, and a Fact changing later shows a note and holds nothing", async () => {
  const subject = crypto.randomUUID();
  const fact = ok(await facts.set(W, { field: "price", subject, value: "$1", source: me, confidence: "high", actor: person }));
  const id = await approvedPlan(planDraft({ measures: [{ key: "m", label: "m", target: "1", basis: { kind: "fact", factId: fact.id, version: fact.version } }] }));
  ok(await facts.set(W, { field: "price", subject, value: "$2", source: me, confidence: "high", actor: person }));
  const after = (await plans.plan(W, id))!;
  expect(after.currentVersion).toBe(1);
  expect(after.notes).toContainEqual({ kind: "fact_changed", factId: fact.id });
});

test("a banned phrase and an off-Strategy step warn, and a person can still approve", async () => {
  ok(await facts.set(W, { field: "never_say", subject: "guaranteed roi", value: "guaranteed ROI", source: me, confidence: "high", actor: person }));
  const p = await newPlan(planDraft({ goal: "Guaranteed ROI for all", steps: [{ key: "seo", on: "2026-11-03", channelKey: "seo", title: "Fix pages" }] }));
  const s = ok(await plans.submitPlan(W, p.id, { revision: p.revision, actor }));
  expect(s.item.warnings.map((w) => w.text)).toEqual(expect.arrayContaining([expect.stringContaining("banned claim"), expect.stringContaining("channel the Strategy doesn't have")]));
  expect(ok(await approve(s.item)).item.state).toBe("applied");
});

test("approving a plan creates no Action and no reservation", async () => {
  const [actions, reservations] = [await count("actions"), await count("touch_reservations")];
  await approvedPlan();
  expect(await count("actions")).toBe(actions);
  expect(await count("touch_reservations")).toBe(reservations);
});

test("an archived plan is hidden, keeps its versions, and takes no more drafts or approvals", async () => {
  const p = await newPlan();
  const s = ok(await plans.submitPlan(W, p.id, { revision: p.revision, actor }));
  ok(await plans.archivePlan(W, p.id));
  expect((await plans.plans(W)).some((x) => x.id === p.id)).toBe(false);
  expect((await plans.planVersions(W, p.id)).length).toBe(1);
  expect(await plans.savePlanDraft(W, p.id, { revision: p.revision, body: {} })).toEqual({ ok: false, reason: "archived" });
  expect(await approve(s.item)).toMatchObject({ ok: false, reason: "archived" });
});

test("progress survives a new version with the same key, and a removed step leaves the view", async () => {
  const steps = [
    { key: "keep", on: "2026-11-03", title: "Keep" },
    { key: "drop", on: "2026-11-04", title: "Drop" },
  ];
  const p = await newPlan(planDraft({ steps }));
  ok(await approve(ok(await plans.submitPlan(W, p.id, { revision: p.revision, actor })).item));
  ok(await plans.markStep(W, p.id, { stepKey: "keep", status: "done", actor }));
  ok(await plans.markStep(W, p.id, { stepKey: "drop", status: "skipped", actor }));
  expect((await plans.plan(W, p.id))!.tracking).toMatchObject({ planned: 2, done: 1, skipped: 1 });

  const saved = ok(await plans.savePlanDraft(W, p.id, { revision: p.revision, body: planDraft({ steps: [{ ...steps[0]!, title: "Renamed" }] }) }));
  ok(await approve(ok(await plans.submitPlan(W, p.id, { revision: saved.revision, actor })).item));
  const t = (await plans.plan(W, p.id))!.tracking!;
  expect(t.steps).toEqual([expect.objectContaining({ key: "keep", title: "Renamed", status: "done" })]);
  expect(t).toMatchObject({ planned: 1, done: 1, skipped: 0 });
  expect(await plans.markStep(W, p.id, { stepKey: "drop", status: "done", actor })).toEqual({ ok: false, reason: "unknown_step" });
});

test("a reading says who wrote it, and a person's and a system's read differently", async () => {
  const id = await approvedPlan();
  ok(await plans.recordReading(W, id, { measureKey: "meetings", value: " 2 ", observedOn: "2026-11-10", actor }));
  expect((await plans.plan(W, id))!.tracking!.measures[0]!.latest).toMatchObject({ value: "2", source: "person", actorUserId: person.userId });
  ok(await plans.recordReading(W, id, { measureKey: "meetings", value: "3", observedOn: "2026-11-11", actor: { system: "reports" } }));
  expect((await plans.plan(W, id))!.tracking!.measures[0]!.latest).toMatchObject({ value: "3", source: "system", actorUserId: null });

  expect(await plans.recordReading(W, id, { measureKey: "meetings", value: "  ", observedOn: "2026-11-10", actor })).toEqual({ ok: false, reason: "blank_value" });
  expect(await plans.recordReading(W, id, { measureKey: "nope", value: "1", observedOn: "2026-11-10", actor })).toEqual({ ok: false, reason: "unknown_measure" });
});

test("tracking waits for an approved version", async () => {
  const p = await newPlan();
  expect((await plans.plan(W, p.id))!.tracking).toBeNull();
  expect(await plans.markStep(W, p.id, { stepKey: "first", status: "done", actor })).toEqual({ ok: false, reason: "not_approved" });
});

test("the list gives each approved plan its dates, main measure and channels by label, and a draft none of them", async () => {
  ok(await approve((await submitStrategy(strategyDraft())).item));
  const id = await approvedPlan(planDraft({ steps: [{ key: "first", on: "2026-11-03", channelKey: "email", title: "First email" }, { key: "talk", on: "2026-11-04", channelKey: "podcast", title: "A talk" }, { key: "last", on: "2026-11-05", title: "Wrap up" }] }));
  const draft = await newPlan();
  const row = async (planId: string) => (await plans.plans(W)).find((p) => p.id === planId);
  // A channel the Strategy doesn't name reads as its key.
  expect(await row(id)).toMatchObject({ startsOn: "2026-11-01", endsOn: "2026-11-30", measure: { label: "Meetings", target: "4", value: null }, channels: ["Cold email", "podcast"] });
  ok(await plans.recordReading(W, id, { measureKey: "meetings", value: "2", observedOn: "2026-11-04", actor }));
  expect((await row(id))!.measure).toEqual({ label: "Meetings", target: "4", value: "2" });
  expect(await row(draft.id)).toMatchObject({ startsOn: null, endsOn: null, measure: null, channels: [] });
});
