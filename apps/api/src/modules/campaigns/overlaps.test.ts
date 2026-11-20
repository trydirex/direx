// SPDX-License-Identifier: AGPL-3.0-only
// A Campaign's overlaps, read off rows Direx records: sent Actions and their events, DMs a person marked sent,
// reply signals and reply Items, and marks. Real plans, items and the reply desk's Item kind; no send.
import { afterAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createFacts, factKinds } from "../facts/index";
import { seedMember } from "../identity/fixtures/member";
import { actionIdOf, itemsWorld, person } from "../items/fixtures/items";
import { createOutreach, replyDeskKind } from "../outreach/index";
import { createPlans, planKinds, type PlanBody } from "../plans/index";
import { campaignKinds, campaignOnPlanApproved, campaignOnPlanCreated, createCampaigns } from "./index";

const { W, items, who, newTouch, newPerson } = await itemsWorld({ kinds: { ...factKinds(), ...planKinds({ onPlanApproved: campaignOnPlanApproved({ items: () => items }) }), ...campaignKinds(), ...replyDeskKind() } });
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const noSend = () => {
  throw new Error("nothing is sent here");
};
const outreach = createOutreach({ items: () => items, send: noSend, baseUrl: () => "http://direx.test" });
const campaigns = createCampaigns({ plans, facts, items: () => items, outreach: () => outreach, startDraft: () => async () => ({ ok: false as const, reason: "not_here" }) });
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

const strategy = ok(
  await plans.saveStrategyDraft(W, {
    revision: (await plans.strategy(W)).draftRevision,
    body: { schemaVersion: 1, whoFor: "Ops", personas: [], positioning: "Audit", channels: [{ key: "email", label: "Email", timing: "now", reason: "Read", basis: { kind: "assumption" } }], assumptions: [] },
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
    { key: "post", on: "2026-11-05", title: "Launch post" },
  ],
  measures: [{ key: "m", label: "Meetings", target: "4", basis: { kind: "assumption" } }],
  budget: [],
  assumptions: [],
};
async function newCampaign(withPost = true) {
  const plan = await plans.createPlan(W, { title: "Q4", createdBy: person.userId });
  const { revision } = ok(await plans.savePlanDraft(W, plan.id, { revision: 0, body }));
  const { item } = ok(await plans.submitPlan(W, plan.id, { revision, actor }));
  ok(await items.approve(W, item.id, item.revision, who));
  const id = (await campaigns.list(W)).find((c) => c.planId === plan.id)!.id;
  ok(await campaigns.setupStep(W, id, "first", { type: "email", touchClass: "cold", mailboxCredentialId: null, audience: "everyone" }));
  ok(await campaigns.setupStep(W, id, "dm", { type: "dm", touchClass: "cold", mailboxCredentialId: null, audience: "everyone", dmChannel: "linkedin" }));
  if (withPost) ok(await campaigns.setupStep(W, id, "post", { type: "post", touchClass: null, mailboxCredentialId: null, audience: "everyone" }));
  return id;
}
/** A day `n` days from today, and noon UTC on it, the same day in the test Workspace's time zone. */
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const noon = (n: number) => `${day(n)}T12:00:00Z`;
async function join(id: string, firstName: string | null = null) {
  const p = await newPerson();
  await q("insert into campaign_people (workspace_id, campaign_id, person_id, first_name, added_by, at) values ($1, $2, $3, $4, $5, now())", [W, id, p, firstName, person.userId]);
  return p;
}
/** An email Action of the first step in `state`, with a move to sent recorded on each of `sentOn`'s days. */
async function email(id: string, personId: string, state: string, ...sentOn: number[]) {
  const actionId = await actionIdOf(W, (await newTouch(personId, null)).id);
  await q("update actions set state = $1 where id = $2", [state, actionId]);
  await q("insert into campaign_actions (workspace_id, campaign_id, step_key, person_id, action_id) values ($1, $2, 'first', $3, $4)", [W, id, personId, actionId]);
  for (const n of sentOn) await q("insert into action_events (workspace_id, action_id, to_state, version, actor_system, at) values ($1, $2, 'sent', 1, 'dispatcher', $3)", [W, actionId, noon(n)]);
  return actionId;
}
async function dm(id: string, personId: string, sentOn: number | null) {
  await q("insert into campaign_dms (workspace_id, campaign_id, step_key, person_id, channel, profile_url, text, template_revision, created_at, sent_at, sent_by) values ($1, $2, 'dm', $3, 'linkedin', 'https://linkedin.com/in/x', 'Hi', 1, now(), $4, $5)", [W, id, personId, sentOn === null ? null : noon(sentOn), sentOn === null ? null : person.userId]);
}
/** A reply received on day `n`, and the reply desk's Item for it with `label`, replacing the one before it. */
async function reply(personId: string, actionId: string, n: number, label: string) {
  const [s] = await q("insert into reply_signals (workspace_id, event_id, sender_email, person_id, action_id, kind, status, text, received_at) values ($1, gen_random_uuid()::text, 'x@example.com', $2, $3, 'reply', 'not_opt_out', 'Hi', $4) returning id", [W, personId, actionId, noon(n)]);
  ok(
    await items.createItem(W, {
      kind: "reply",
      replace: true,
      payload: { signalId: s.id, thread: [s.id], personId, actionId, label, quote: null, owner: { userIds: [person.userId], rule: "workspace_owners" } },
      actor: { system: "outreach" },
      details: { title: "A reply", workArea: "outreach", channel: "email", groupKey: `reply:${personId}:${actionId}`, warnings: [] },
    }),
  );
}
const mark = async (id: string, personId: string, kind: "meeting" | "deal", n: number) => ok(await campaigns.markOutcome(W, id, { personId, kind, on: day(n), userId: person.userId })).outcome;
const kindOf = async (id: string, kind: string) => (await campaigns.overlaps(W, id))!.kinds.find((k) => k.kind === kind)!;
const row = (channels: string[], reached: number, outcomes: number) => ({ channels, reached, outcomes, rate: null });

test("only sent emails and DMs marked sent are Touches, and a resent email is one Touch on its first sent day", async () => {
  const id = await newCampaign();
  const [resent, unsent, dmed, unmarked] = [await join(id, "Ana"), await join(id), await join(id), await join(id)];
  await q("insert into person_keys (workspace_id, person_id, kind, value, created_at) values ($1, $2, 'email', 'ana@example.com', now())", [W, resent]);
  await email(id, resent, "sent", -6, -3);
  await email(id, unsent, "needs_approval");
  await dm(id, dmed, -5);
  await dm(id, unmarked, null);
  await mark(id, resent, "meeting", -1);

  const r = (await campaigns.overlaps(W, id))!;
  expect(r.hasPosts).toBe(true);
  expect(r.kinds.map((k) => k.kind)).toEqual(["interested", "meeting", "deal"]);
  expect(r.kinds[0]).toEqual({ kind: "interested", rows: [row(["email"], 1, 0), row(["linkedin_dm"], 1, 0)], people: [], more: 0 });
  expect(r.kinds[1]).toEqual({
    kind: "meeting",
    rows: [row(["email"], 1, 1), row(["linkedin_dm"], 1, 0)],
    people: [{ personId: resent, name: "Ana", email: "ana@example.com", on: day(-1), touches: [{ on: day(-6), stepKey: "first", title: "First email", channel: "email" }] }],
    more: 0,
  });
});

test("a meeting before the first DM is in the email-only row for meetings; an undone mark is no outcome", async () => {
  const id = await newCampaign();
  const [early, undone] = [await join(id), await join(id)];
  await email(id, early, "sent", -6);
  await mark(id, early, "meeting", -4);
  await dm(id, early, -2);
  await email(id, undone, "sent", -6);
  await dm(id, undone, -5);
  const m = await mark(id, undone, "meeting", -3);
  ok(await campaigns.undoOutcome(W, id, { markId: m.id, userId: person.userId }));

  const meetings = await kindOf(id, "meeting");
  expect(meetings.rows).toEqual([row(["email"], 1, 1), row(["email", "linkedin_dm"], 1, 0)]);
  expect(meetings.people.map((p) => p.personId)).toEqual([early]);
  // Without a deal, each Person's mix is every Touch they got.
  expect((await kindOf(id, "deal")).rows).toEqual([row(["email", "linkedin_dm"], 2, 0)]);
});

test("an interested reply later replaced is still an outcome, dated by its reply's signal", async () => {
  const id = await newCampaign();
  const p = await join(id);
  const sent = await email(id, p, "sent", -6);
  await reply(p, sent, -4, "interested");
  await dm(id, p, -3);
  await reply(p, sent, -2, "not_now");

  const interested = await kindOf(id, "interested");
  expect(interested.rows).toEqual([row(["email"], 1, 1)]);
  expect(interested.people).toEqual([{ personId: p, name: null, email: null, on: day(-4), touches: [{ on: day(-6), stepKey: "first", title: "First email", channel: "email" }] }]);
});

test("another Workspace's rows never count, and a Campaign without a post step has no posts line", async () => {
  const id = await newCampaign(false);
  const p = await join(id);
  const sent = await email(id, p, "sent", -6);
  const other = crypto.randomUUID();
  await seedMember(other, person.userId);
  const [s] = await q("insert into reply_signals (workspace_id, event_id, sender_email, kind, status, received_at) values ($1, 'e', 'x@example.com', 'reply', 'not_opt_out', now()) returning id", [other], other);
  // Its Item names this Workspace's email, which its own Workspace can't see.
  await q("insert into items (workspace_id, kind, state, title, warnings, payload, created_at, updated_at) values ($1, 'reply', 'needs_approval', 'A reply', '[]'::jsonb, $2, now(), now())", [other, { personId: p, actionId: sent, signalId: s.id, label: "interested" }], other);

  const r = (await campaigns.overlaps(W, id))!;
  expect(r.hasPosts).toBe(false);
  expect(r.kinds[0]).toEqual({ kind: "interested", rows: [row(["email"], 1, 0)], people: [], more: 0 });
  expect(await campaigns.overlaps(other, id)).toBeUndefined();
});
