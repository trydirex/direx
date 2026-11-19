// SPDX-License-Identifier: AGPL-3.0-only
// The daily readings sweep against real plans, items and the reply desk's Item kind: what it counts, when
// it writes, and what it leaves alone. Plan dates are relative to today, as the sweep's window is.
import { afterAll, expect, test, vi } from "vitest";
import { appClient } from "../../../../../test/db";
import { createFacts, factKinds } from "../facts/index";
import { actionIdOf, itemsWorld, person } from "../items/fixtures/items";
import { replyDeskKind } from "../outreach/index";
import { createPlans, planKinds, type PlanBody } from "../plans/index";
import { campaignReadings } from "./application/readings";
import { campaignKinds, campaignOnPlanApproved, campaignOnPlanCreated, createCampaigns } from "./index";

const { W, items, who, newTouch, newPerson } = await itemsWorld({ kinds: { ...factKinds(), ...planKinds({ onPlanApproved: campaignOnPlanApproved({ items: () => items }) }), ...campaignKinds(), ...replyDeskKind() } });
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const noOutreach = () => {
  throw new Error("nothing is sent here");
};
const campaigns = createCampaigns({ plans, facts, items: () => items, outreach: noOutreach, startDraft: () => async () => ({ ok: false as const, reason: "not_here" }) });
const actor = { userId: person.userId };
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};

const db = await appClient();
afterAll(() => db.end());
async function q(text: string, params: unknown[] = []) {
  await db.query("begin");
  await db.query("select set_config('app.workspace_id', $1, true)", [W]);
  const r = await db.query(text, params);
  await db.query("commit");
  return r.rows;
}

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const today = day(0);

const strategy = ok(
  await plans.saveStrategyDraft(W, {
    revision: (await plans.strategy(W)).draftRevision,
    body: { schemaVersion: 1, whoFor: "Ops", personas: [], positioning: "Audit", channels: [{ key: "email", label: "Email", timing: "now", reason: "Read", basis: { kind: "assumption" } }], assumptions: [] },
  }),
);
const strategyItem = ok(await plans.submitStrategy(W, { revision: strategy.revision, actor })).item;
ok(await items.approve(W, strategyItem.id, strategyItem.revision, who));

const measure = (key: string, source?: PlanBody["measures"][number]["source"]) => ({ key, label: key, target: "4", basis: { kind: "assumption" as const }, ...(source && { source }) });
/** A Campaign whose plan ends `endsIn` days from today, approved unless said otherwise. */
async function newCampaign(endsIn = 10, approve = true) {
  const startsOn = day(endsIn - 20);
  const body: PlanBody = {
    schemaVersion: 1,
    goal: "4 meetings",
    audience: "Ops",
    startsOn,
    endsOn: day(endsIn),
    steps: [{ key: "first", on: startsOn, title: "First email" }],
    measures: [measure("replies", "replies"), measure("interested", "interested_replies"), measure("meetings", "meetings"), measure("deals", "deals"), measure("signups", "external"), measure("old")],
    budget: [],
    assumptions: [],
  };
  const plan = await plans.createPlan(W, { title: "Q4", createdBy: person.userId });
  const { revision } = ok(await plans.savePlanDraft(W, plan.id, { revision: 0, body }));
  if (approve) {
    const { item } = ok(await plans.submitPlan(W, plan.id, { revision, actor }));
    ok(await items.approve(W, item.id, item.revision, who));
  }
  const [c] = await q("select id from campaigns where plan_id = $1", [plan.id]);
  return { id: c.id as string, planId: plan.id };
}
async function join(id: string) {
  const p = await newPerson();
  await q("insert into campaign_people (workspace_id, campaign_id, person_id, added_by, at) values ($1, $2, $3, $4, now())", [W, id, p, person.userId]);
  return p;
}
async function email(id: string, personId: string, state = "sent") {
  const actionId = await actionIdOf(W, (await newTouch(personId, null)).id);
  await q("update actions set state = $1 where id = $2", [state, actionId]);
  await q("insert into campaign_actions (workspace_id, campaign_id, step_key, person_id, action_id) values ($1, $2, 'first', $3, $4)", [W, id, personId, actionId]);
  return actionId;
}
async function interestedReply(personId: string, actionId: string) {
  const [s] = await q("insert into reply_signals (workspace_id, event_id, sender_email, person_id, action_id, kind, status, text, received_at) values ($1, gen_random_uuid()::text, 'x@example.com', $2, $3, 'reply', 'not_opt_out', 'Yes', now()) returning id", [W, personId, actionId]);
  ok(
    await items.createItem(W, {
      kind: "reply",
      replace: true,
      payload: { signalId: s.id, thread: [s.id], personId, actionId, label: "interested", quote: null, owner: { userIds: [person.userId], rule: "workspace_owners" } },
      actor: { system: "outreach" },
      details: { title: "A reply", workArea: "outreach", channel: "email", groupKey: `reply:${personId}:${actionId}`, warnings: [] },
    }),
  );
}
const mark = async (id: string, personId: string, kind: "meeting" | "deal" = "meeting") => ok(await campaigns.markOutcome(W, id, { personId, kind, on: day(-1), userId: person.userId })).outcome;
/** Each Measure's readings, oldest first, as value and source. */
async function readings(planId: string) {
  const out: Record<string, string[]> = {};
  for (const m of (await plans.plan(W, planId))?.tracking?.measures ?? []) out[m.key] = [...m.readings].sort((a, b) => a.at.getTime() - b.at.getTime()).map((r) => `${r.value} ${r.source}`);
  return out;
}

test("replies wait for the first sent email; two runs on a day write once, and a new interested reply writes again", async () => {
  const { id, planId } = await newCampaign();
  await email(id, await join(id), "needs_approval");
  await campaigns.countReadings();
  expect(await readings(planId)).toMatchObject({ replies: [], interested: [] });

  const p = await join(id);
  const sent = await email(id, p);
  await campaigns.countReadings();
  await campaigns.countReadings();
  expect(await readings(planId)).toEqual({ replies: ["0 system"], interested: ["0 system"], meetings: [], deals: [], signups: [], old: [] });
  expect((await plans.plan(W, planId))!.tracking!.measures[0]!.latest).toMatchObject({ observedOn: today, source: "system" });

  await interestedReply(p, sent);
  await campaigns.countReadings();
  // An external Measure, and one from before sources existed, are never written.
  expect(await readings(planId)).toEqual({ replies: ["0 system", "1 system"], interested: ["0 system", "1 system"], meetings: [], deals: [], signups: [], old: [] });
});

test("meetings get no row before a mark, then follow a mark and its undo down to 0; deals stay unwritten", async () => {
  const { id, planId } = await newCampaign();
  const p = await join(id);
  await campaigns.countReadings();
  expect(await readings(planId)).toMatchObject({ meetings: [], deals: [] });

  const m = await mark(id, p);
  await campaigns.countReadings();
  expect(await readings(planId)).toMatchObject({ meetings: ["1 system"], deals: [] });
  ok(await campaigns.undoOutcome(W, id, { markId: m.id, userId: person.userId }));
  await campaigns.countReadings();
  expect(await readings(planId)).toMatchObject({ meetings: ["1 system", "0 system"], deals: [] });
});

test("a person's correction stays the shown value after a sweep that sees no change", async () => {
  const { id, planId } = await newCampaign();
  await mark(id, await join(id));
  await campaigns.countReadings();
  ok(await plans.recordReading(W, planId, { measureKey: "meetings", value: "3", observedOn: today, actor }));
  await campaigns.countReadings();
  const meetings = (await plans.plan(W, planId))!.tracking!.measures.find((m) => m.key === "meetings")!;
  expect(meetings.latest).toMatchObject({ value: "3", source: "person" });
  expect(meetings.readings).toHaveLength(2);
});

test("an unapproved plan and a Campaign more than 30 days past its end are never written; 30 days past still is", async () => {
  const unapproved = await newCampaign(10, false);
  const longOver = await newCampaign(-31);
  const justOver = await newCampaign(-30);
  for (const c of [unapproved, longOver, justOver]) await mark(c.id, await join(c.id));
  await campaigns.countReadings();
  for (const c of [unapproved, longOver]) expect(await q("select count(*)::int as n from plan_measure_readings where plan_id = $1", [c.planId])).toEqual([{ n: 0 }]);
  expect(await readings(justOver.planId)).toMatchObject({ meetings: ["1 system"] });
});

test("one Campaign failing is logged and the next is still counted", async () => {
  const broken = await newCampaign();
  const fine = await newCampaign();
  for (const c of [broken, fine]) await mark(c.id, await join(c.id));
  const failed = vi.spyOn(console, "error").mockImplementation(() => {});
  const sweep = campaignReadings({
    plans: { ...plans, plan: async (w, planId) => (planId === broken.planId ? Promise.reject(new Error("plan read failed")) : plans.plan(w, planId)) },
    now: () => new Date(),
  });
  await sweep.countReadings();
  expect(failed).toHaveBeenCalledWith("campaigns: counting readings failed", expect.objectContaining({ planId: broken.planId }), expect.any(Error));
  failed.mockRestore();
  expect(await readings(broken.planId)).toMatchObject({ meetings: [] });
  expect(await readings(fine.planId)).toMatchObject({ meetings: ["1 system"] });
});
