// SPDX-License-Identifier: AGPL-3.0-only
// A Campaign's write-up against real plans, items and marks: the brief its writer is given, claiming the
// one write-up, and the sink keeping or refusing what a scripted run wrote. No model and no send.
import { afterAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createFacts, factKinds } from "../facts/index";
import { seedMember } from "../identity/fixtures/member";
import { actionIdOf, itemsWorld, person } from "../items/fixtures/items";
import { createOutreach } from "../outreach/index";
import { createPlans, planKinds, type PlanBody } from "../plans/index";
import { WRITE_UP_CASES, writeUpCaseErrors } from "./definitions/eval-cases";
import { WRITE_UP_OUTPUT_KEY } from "./definitions/write-up";
import type { WriteUpOutput } from "./domain/write-up";
import { campaignKinds, campaignOnPlanApproved, campaignOnPlanCreated, campaignSinks, createCampaigns, type StartDraft } from "./index";

const { W, items, who, newTouch, newPerson } = await itemsWorld({ kinds: { ...factKinds(), ...planKinds({ onPlanApproved: campaignOnPlanApproved({ items: () => items }) }), ...campaignKinds() } });
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const noSend = () => {
  throw new Error("nothing is sent here");
};
const outreach = createOutreach({ items: () => items, send: noSend, baseUrl: () => "http://direx.test" });
const started: Parameters<StartDraft>[1][] = [];
let startReply: Awaited<ReturnType<StartDraft>> = { ok: true, run: { id: crypto.randomUUID() } };
const campaigns = createCampaigns({ plans, facts, items: () => items, outreach: () => outreach, startDraft: () => async (_w, a) => (started.push(a), startReply) });
const sink = campaignSinks({ facts, items: () => items, writeUps: () => campaigns }).byKey[WRITE_UP_OUTPUT_KEY]!;
const actor = { userId: person.userId };
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};

const db = await appClient();
afterAll(() => db.end());
async function q(text: string, params: unknown[] = [], workspaceId = W) {
  await db.query("begin");
  await db.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
  const r = await db.query(text, params);
  await db.query("commit");
  return r.rows;
}

const ASSUMPTION = "Ops leads read email on Mondays.";
const strategy = ok(
  await plans.saveStrategyDraft(W, {
    revision: (await plans.strategy(W)).draftRevision,
    body: { schemaVersion: 1, whoFor: "Ops", personas: [], positioning: "Audit", channels: [{ key: "email", label: "Email", timing: "now", reason: "Read", basis: { kind: "assumption" } }], assumptions: [{ text: ASSUMPTION }] },
  }),
);
const strategyItem = ok(await plans.submitStrategy(W, { revision: strategy.revision, actor })).item;
ok(await items.approve(W, strategyItem.id, strategyItem.revision, who));

const body: PlanBody = {
  schemaVersion: 1,
  goal: "4 meetings",
  audience: "Ops",
  startsOn: "2026-11-01",
  endsOn: "2026-11-30",
  steps: [
    { key: "first", on: "2026-11-03", title: "First email" },
    { key: "dm", on: "2026-11-04", title: "LinkedIn note" },
  ],
  measures: [{ key: "m", label: "Meetings", target: "4", basis: { kind: "assumption" }, source: "meetings" }],
  budget: [],
  assumptions: [],
};
async function newCampaign(b = body) {
  const plan = await plans.createPlan(W, { title: "Q4 audits", createdBy: person.userId });
  const { revision } = ok(await plans.savePlanDraft(W, plan.id, { revision: 0, body: b }));
  const { item } = ok(await plans.submitPlan(W, plan.id, { revision, actor }));
  ok(await items.approve(W, item.id, item.revision, who));
  const id = (await campaigns.list(W)).find((c) => c.planId === plan.id)!.id;
  ok(await campaigns.setupStep(W, id, "first", { type: "email", touchClass: "cold", mailboxCredentialId: null, audience: "everyone" }));
  ok(await campaigns.setupStep(W, id, "dm", { type: "dm", touchClass: "cold", mailboxCredentialId: null, audience: "everyone", dmChannel: "linkedin" }));
  return { id, planId: plan.id };
}
const noon = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10) + "T12:00:00Z";
/** A Person sent the first step's email, and the LinkedIn DM too when `dm`, then marked with a meeting. */
async function reached(id: string, dm: boolean) {
  const p = await newPerson();
  await q("insert into campaign_people (workspace_id, campaign_id, person_id, added_by, at) values ($1, $2, $3, $4, now())", [W, id, p, person.userId]);
  const touch = await newTouch(p, null);
  const actionId = await actionIdOf(W, touch.id);
  await q("update actions set state = 'sent' where id = $1", [actionId]);
  await q("update items set group_key = $1 where id = $2", [`campaign:${id}:step:first`, touch.id]);
  await q("insert into campaign_actions (workspace_id, campaign_id, step_key, person_id, action_id) values ($1, $2, 'first', $3, $4)", [W, id, p, actionId]);
  await q("insert into action_events (workspace_id, action_id, to_state, version, actor_system, at) values ($1, $2, 'sent', 1, 'dispatcher', $3)", [W, actionId, noon(-6)]);
  if (dm) await q("insert into campaign_dms (workspace_id, campaign_id, step_key, person_id, channel, profile_url, text, template_revision, created_at, sent_at, sent_by) values ($1, $2, 'dm', $3, 'linkedin', 'https://linkedin.com/in/x', 'Hi', 1, now(), $4, $5)", [W, id, p, noon(-5), person.userId]);
  ok(await campaigns.markOutcome(W, id, { personId: p, kind: "meeting", on: noon(-1).slice(0, 10), userId: person.userId }));
}
const reading = async (planId: string, value: string, observedOn: string) => {
  ok(await plans.recordReading(W, planId, { measureKey: "m", value, observedOn, actor }));
  return (await q("select id from plan_measure_readings where plan_id = $1 and value = $2", [planId, value]))[0].id as string;
};
const writeUpOf = async (id: string, workspaceId = W) => (await q("select status, paragraph, cites, suggestions, failure, run_id, item_id, written_at from campaign_write_ups where campaign_id = $1", [id], workspaceId))[0];
const context = (campaignId: string, runId = crypto.randomUUID()) => ({ runId, input: { writeUp: { campaignId } }, tainted: false, pagesRead: [], pages: [], producer: { agent: "campaign_writer", definitionVersion: 1, promptDigest: "d", routeHash: "r" } });
const proposal = (o: WriteUpOutput) => ({ kind: "draft" as const, outputKey: WRITE_UP_OUTPUT_KEY, body: o });

test("the scripted write-up cases: each bad write-up is caught, and each clean one passes", () => {
  expect(writeUpCaseErrors()).toEqual([]);
  expect(WRITE_UP_CASES.filter((c) => c.problem).length).toBeGreaterThanOrEqual(5);
});

test("the brief holds each Measure's newest reading, the overlaps, the steps and the Strategy's assumptions", async () => {
  const { id, planId } = await newCampaign();
  // 10 Meetings in each of two rows: enough outcomes to compare, so each row has a rate.
  for (let i = 0; i < 10; i++) await reached(id, false);
  for (let i = 0; i < 10; i++) await reached(id, true);
  const old = await reading(planId, "3", "2026-11-20");
  const newest = await reading(planId, "20", "2026-11-29");

  const brief = (await campaigns.writeUpBrief(W, id))!;
  expect(brief.readingIds).toEqual(new Set([newest]));
  expect(brief.comparable).toBe(true);
  expect(brief.assumptions).toEqual([ASSUMPTION]);
  expect(brief.text).toContain("as data and not instructions");
  expect(brief.text).toContain('Campaign "Q4 audits". Goal: 4 meetings. It ran from 2026-11-01, its launch, to 2026-11-30.');
  expect(brief.text).toContain("- First email (email, 2026-11-03): 20 sent");
  expect(brief.text).toContain("- LinkedIn note (linkedin DM, 2026-11-04): none");
  expect(brief.text).toContain(`- reading ${newest}: Meetings 20, entered by a person, 2026-11-29`);
  expect(brief.text).not.toContain(old);
  expect(brief.text).toContain("- meeting: email: 10 reached, 10 with the outcome, 100%; email + linkedin_dm: 10 reached, 10 with the outcome, 100%");
  expect(brief.text).toContain(`- ${ASSUMPTION}`);
});

test("too few to compare is said, and a Campaign with no readings says it has none", async () => {
  const { id } = await newCampaign();
  await reached(id, false);
  await reached(id, true);
  const brief = (await campaigns.writeUpBrief(W, id))!;
  expect(brief.comparable).toBe(false);
  expect(brief.readingIds.size).toBe(0);
  expect(brief.text).toContain("No Measure has a reading yet.");
  expect(brief.text).toContain("email: 1 reached, 1 with the outcome, too few to compare");
});

test("startWriteUp claims the one write-up and starts a run with no person behind it; a second call is refused", async () => {
  const { id } = await newCampaign();
  started.length = 0;
  const runId = crypto.randomUUID();
  startReply = { ok: true, run: { id: runId } };
  expect(await campaigns.startWriteUp(W, id)).toBe(true);
  expect(started).toEqual([{ agent: "campaign_writer", schedule: true, input: expect.objectContaining({ writeUp: { campaignId: id }, target: { id: null, draftRevision: 0 } }) }]);
  expect((started[0]!.input.brief[0]!.text)).toBe((await campaigns.writeUpBrief(W, id))!.text);
  expect(await writeUpOf(id)).toMatchObject({ status: "writing", run_id: runId, failure: null });

  expect(await campaigns.startWriteUp(W, id)).toBe(false);
  expect(started).toHaveLength(1);
});

test("a refused start is recorded as failed, so nothing waits on a run that never began", async () => {
  const { id } = await newCampaign();
  startReply = { ok: false, reason: "no_route" };
  expect(await campaigns.startWriteUp(W, id)).toBe(true);
  expect(await writeUpOf(id)).toMatchObject({ status: "failed", failure: "not_started:no_route", run_id: null });
  startReply = { ok: true, run: { id: crypto.randomUUID() } };
});

test("the sink keeps a write-up that holds to its brief, and refuses an invented number, keeping the old paragraph", async () => {
  const { id, planId } = await newCampaign();
  await reached(id, false);
  const r = await reading(planId, "1", "2026-11-29");
  const runId = crypto.randomUUID();
  startReply = { ok: true, run: { id: runId } };
  await campaigns.startWriteUp(W, id);
  const good: WriteUpOutput = {
    schemaVersion: 1,
    paragraph: "Q4 audits sent 1 email. The 1 Person reached by email booked 1 meeting.",
    cites: [r],
    suggestions: [{ assumption: "Ops leads take a meeting after one email.", because: "Direx counted 1 meeting from 1 email.", readingIds: [r] }],
  };
  const kept = ok(await sink(W, proposal(good), context(id, runId)));
  const written = await writeUpOf(id);
  expect(written).toMatchObject({ status: "written", paragraph: good.paragraph, cites: [r], suggestions: good.suggestions, failure: null, run_id: runId, item_id: kept.itemId });
  expect(written.written_at).not.toBeNull();
  // One suggestion, so one Item that says so.
  expect(await q("select id, title from items where kind = 'strategy_assumptions' and group_key = $1", [`strategy_assumptions:${id}`])).toEqual([{ id: kept.itemId, title: "Add 1 assumption to your Strategy?" }]);

  // A late answer from another run can't overwrite it.
  expect(await sink(W, proposal({ ...good, paragraph: "Q4 audits sent 1 email." }), context(id))).toEqual({ ok: false, code: "not_found" });
  expect(await writeUpOf(id)).toMatchObject({ status: "written", paragraph: good.paragraph });

  expect(await sink(W, proposal({ ...good, paragraph: "Q4 audits booked 37,000,000 meetings." }), context(id, runId))).toEqual({ ok: false, code: "number_not_in_brief:37000000" });
  expect(await writeUpOf(id)).toMatchObject({ status: "failed", failure: "number_not_in_brief:37000000", paragraph: good.paragraph });
});

test("nothing crosses Workspaces, and a sink without write-ups wired in refuses", async () => {
  const { id } = await newCampaign();
  const other = crypto.randomUUID();
  await seedMember(other, person.userId);
  expect(await campaigns.writeUpBrief(other, id)).toBeUndefined();
  expect(await campaigns.startWriteUp(other, id)).toBe(false);
  const out: WriteUpOutput = { schemaVersion: 1, paragraph: "Nothing went out.", cites: [], suggestions: [] };
  expect(await sink(other, proposal(out), context(id))).toEqual({ ok: false, code: "not_found" });
  expect(await writeUpOf(id)).toBeUndefined();
  expect(await campaignSinks({ facts }).byKey[WRITE_UP_OUTPUT_KEY]!(W, proposal(out), context(id))).toEqual({ ok: false, code: "no_write_ups" });
  // A Campaign with a brief but no write-up row has nothing to write to.
  expect(await sink(W, proposal(out), context(id))).toEqual({ ok: false, code: "not_found" });
});

// The trigger: dates relative to today, since a write-up waits for the end and the grace days after it.
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const endedBy = (daysAgo: number): PlanBody => ({
  ...body,
  startsOn: day(-daysAgo - 20),
  endsOn: day(-daysAgo),
  steps: [
    { key: "first", on: day(-daysAgo - 18), title: "First email" },
    { key: "dm", on: day(-daysAgo - 17), title: "LinkedIn note" },
  ],
});
/** An email still Held on the first step. */
async function held(id: string) {
  const touch = await newTouch(await newPerson(), null);
  await q("update actions set state = 'held', hold_reason = 'cap' where id = $1", [await actionIdOf(W, touch.id)]);
  await q("update items set group_key = $1 where id = $2", [`campaign:${id}:step:first`, touch.id]);
}
const runsFor = (id: string) => started.filter((s) => (s.input as { writeUp?: { campaignId: string } }).writeUp?.campaignId === id).length;

test("the daily pass starts one write-up for an ended, settled Campaign, and two at once start one", async () => {
  startReply = { ok: true, run: { id: crypto.randomUUID() } };
  const { id } = await newCampaign(endedBy(2));
  await reached(id, false);
  await campaigns.countReadings();
  expect(runsFor(id)).toBe(1);
  expect(await writeUpOf(id)).toMatchObject({ status: "writing" });
  // Already written or being written: nothing more.
  expect(await campaigns.maybeWriteUp(W, id)).toBe(false);
  expect(runsFor(id)).toBe(1);

  const twice = await newCampaign(endedBy(2));
  await reached(twice.id, false);
  expect((await Promise.all([campaigns.maybeWriteUp(W, twice.id), campaigns.maybeWriteUp(W, twice.id)])).sort()).toEqual([false, true]);
  expect(runsFor(twice.id)).toBe(1);
});

test("running, Held under 14 days, or never sent gets no write-up; Held past 14 days gets one", async () => {
  const running = await newCampaign(endedBy(-3));
  await reached(running.id, false);
  const heldRecently = await newCampaign(endedBy(13));
  await reached(heldRecently.id, false);
  await held(heldRecently.id);
  const neverSent = await newCampaign(endedBy(2));
  await held(neverSent.id);
  const heldLong = await newCampaign(endedBy(15));
  await reached(heldLong.id, false);
  await held(heldLong.id);

  for (const c of [running, heldRecently, neverSent]) expect(await campaigns.maybeWriteUp(W, c.id)).toBe(false);
  expect(await campaigns.maybeWriteUp(W, heldLong.id)).toBe(true);
  for (const c of [running, heldRecently, neverSent]) expect(await writeUpOf(c.id)).toBeUndefined();
  // Another Workspace can't see it.
  expect(await campaigns.maybeWriteUp(crypto.randomUUID(), heldLong.id)).toBe(false);
});

// The suggestions Item.
// Each test adds to the one Strategy, so each suggests for another sector, never repeating an assumption.
const suggested = (sector: string) => [`Ops leads in ${sector} answer a short first email.`, `Ops leads in ${sector} book a meeting within a week.`, `A LinkedIn note adds little for ops leads in ${sector}.`];
const SUGGESTED = suggested("retail");
const itemOf = async (id: string) => (await q("select id, state, title, group_label, payload from items where kind = 'strategy_assumptions' and group_key = $1 order by created_at", [`strategy_assumptions:${id}`])).at(-1);
const assumptionsNow = async (workspaceId = W) => (await plans.strategy(workspaceId)).current!.assumptions.map((a) => a.text);
/** A Campaign whose write-up was written with these suggestions. */
async function writtenUp(texts: string[]) {
  const { id, planId } = await newCampaign();
  await reached(id, false);
  const r = await reading(planId, "1", "2026-11-29");
  const runId = crypto.randomUUID();
  startReply = { ok: true, run: { id: runId } };
  await campaigns.startWriteUp(W, id);
  const out: WriteUpOutput = { schemaVersion: 1, paragraph: "Q4 audits sent 1 email.", cites: [r], suggestions: texts.map((assumption) => ({ assumption, because: "Direx counted 1 meeting from 1 email.", readingIds: [r] })) };
  const kept = ok(await sink(W, proposal(out), context(id, runId)));
  return { id, r, runId, out, itemId: kept.itemId! };
}
const approveWith = async (itemId: string, choice?: unknown, workspaceId = W) => items.approve(workspaceId, itemId, (await items.view(workspaceId, itemId))!.revision, who, choice === undefined ? undefined : JSON.stringify(choice));

test("approving two of three, one edited, adds exactly those to a new Strategy version and marks each suggestion; a draft is left alone", async () => {
  const { id, itemId, out } = await writtenUp(SUGGESTED);
  expect(await itemOf(id)).toEqual({ id: itemId, state: "needs_approval", title: "Add 3 assumptions to your Strategy?", group_label: "Q4 audits", payload: { campaignId: id, suggestions: out.suggestions } });
  expect((await writeUpOf(id)).item_id).toBe(itemId);

  const before = await plans.strategy(W);
  const draft = { ...before.current!, positioning: "A draft nobody submitted" };
  const { revision } = ok(await plans.saveStrategyDraft(W, { revision: before.draftRevision, body: draft }));
  const versions = (await plans.strategyVersions(W)).length;

  ok(await approveWith(itemId, { add: [{ index: 0 }, { index: 2, text: "  A LinkedIn note adds little.  " }] }));
  const after = await plans.strategy(W);
  expect(after.current!.assumptions.map((a) => a.text)).toEqual([...before.current!.assumptions.map((a) => a.text), SUGGESTED[0], "A LinkedIn note adds little."]);
  expect(after.currentVersion).toBe(versions + 1);
  expect(await plans.strategyVersions(W)).toHaveLength(versions + 1);
  expect((await plans.strategyVersions(W)).at(-1)).toMatchObject({ baseVersion: before.currentVersion, actorUserId: person.userId });
  expect(after.draft).toEqual(draft);
  expect(after.draftRevision).toBe(revision);
  expect((await writeUpOf(id)).suggestions.map((s: { outcome: string }) => s.outcome)).toEqual(["added", "not_added", "added"]);
  expect((await itemOf(id)).state).toBe("applied");
});

test("a choice must tick at least one suggestion in range, with texts of 1 to 400 characters", async () => {
  const { id, itemId } = await writtenUp(suggested("finance").slice(0, 2));
  const before = await assumptionsNow();
  const refusals = [undefined, "not json", { add: "all" }, { add: [] }, { add: [{ index: 2 }] }, { add: [{ index: 0 }, { index: 0 }] }, { add: [{ index: 0, text: " " }] }, { add: [{ index: 0, text: "x".repeat(401) }] }];
  const reasons = [];
  for (const c of refusals) reasons.push((await (typeof c === "string" ? items.approve(W, itemId, (await items.view(W, itemId))!.revision, who, c) : approveWith(itemId, c))) as { reason?: string });
  expect(reasons.map((r) => r.reason)).toEqual(["choice_required", "invalid_choice", "invalid_choice", "choice_required", "invalid_choice", "invalid_choice", "invalid_choice", "invalid_choice"]);
  expect(await assumptionsNow()).toEqual(before);
  expect((await itemOf(id)).state).toBe("needs_approval");
});

test("dismissing adds nothing and marks every suggestion not added", async () => {
  const { id, itemId } = await writtenUp(suggested("logistics").slice(0, 2));
  const versions = (await plans.strategyVersions(W)).length;
  ok(await items.cancel(W, itemId, actor));
  expect((await writeUpOf(id)).suggestions.map((s: { outcome: string }) => s.outcome)).toEqual(["not_added", "not_added"]);
  expect(await plans.strategyVersions(W)).toHaveLength(versions);
});

test("a rewritten write-up replaces the open Item, and one with no suggestions leaves none", async () => {
  const { id, r, out, itemId } = await writtenUp(suggested("health"));
  const rewrite = async (suggestions: WriteUpOutput["suggestions"]) => {
    const runId = crypto.randomUUID();
    await q("update campaign_write_ups set status = 'writing', run_id = $2 where campaign_id = $1", [id, runId]);
    return ok(await sink(W, proposal({ ...out, suggestions }), context(id, runId))).itemId;
  };
  const next = await rewrite([{ assumption: "Ops leads reply on Mondays.", because: "Direx counted 1 meeting.", readingIds: [r] }]);
  expect(next).not.toBe(itemId);
  expect((await q("select state from items where id = $1", [itemId]))[0].state).toBe("cancelled");
  expect(await q("select state, title, group_key from items where id = $1", [next])).toEqual([{ state: "needs_approval", title: "Add 1 assumption to your Strategy?", group_key: `strategy_assumptions:${id}` }]);
  expect((await writeUpOf(id)).item_id).toBe(next);

  expect(await rewrite([])).toBeNull();
  expect((await q("select state from items where id = $1", [next]))[0].state).toBe("cancelled");
  expect((await writeUpOf(id)).item_id).toBeNull();
});

test("it refuses with no approved Strategy, and past 20 assumptions, saying how many there are", async () => {
  const suggestion = { assumption: "Ops leads read email.", because: "Seen.", readingIds: [] };
  const offer = async (workspaceId: string) =>
    ok(await items.createItem(workspaceId, { kind: "strategy_assumptions", payload: { campaignId: crypto.randomUUID(), suggestions: [suggestion, suggestion] }, actor: { system: "campaigns" }, details: { title: "Add 2 assumptions to your Strategy?", workArea: "Plans", warnings: [] } })).item.id;

  const empty = crypto.randomUUID();
  await seedMember(empty, person.userId);
  expect(await approveWith(await offer(empty), { add: [{ index: 0 }] }, empty)).toMatchObject({ ok: false, reason: "no_strategy" });

  const full = crypto.randomUUID();
  await seedMember(full, person.userId);
  const nineteen = Array.from({ length: 19 }, (_, i) => ({ text: `Assumption ${i}` }));
  const saved = ok(await plans.saveStrategyDraft(full, { revision: 0, body: { ...(await plans.strategy(W)).current!, assumptions: nineteen } }));
  const version = ok(await plans.submitStrategy(full, { revision: saved.revision, actor })).item;
  ok(await items.approve(full, version.id, version.revision, who));
  const itemId = await offer(full);
  expect(await approveWith(itemId, { add: [{ index: 0 }, { index: 1 }] }, full)).toMatchObject({ ok: false, reason: "too_many_assumptions:19" });
  ok(await approveWith(itemId, { add: [{ index: 1, text: "The twentieth." }] }, full));
  expect(await assumptionsNow(full)).toEqual([...nineteen.map((a) => a.text), "The twentieth."]);
});
