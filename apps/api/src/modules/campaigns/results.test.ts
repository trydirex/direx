// SPDX-License-Identifier: AGPL-3.0-only
// A Campaign's step funnel from rows Direx records: sent Actions, reply signals and reply Items, DMs a
// person marked sent and published posts. Real plans, items and the reply desk's Item kind; no send.
import { afterAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createFacts, factKinds } from "../facts/index";
import { seedMember } from "../identity/fixtures/member";
import { actionIdOf, itemsWorld, person } from "../items/fixtures/items";
import { createOutreach, replyDeskKind } from "../outreach/index";
import { createPlans, planKinds, type PlanBody } from "../plans/index";
import { inWorkspace, markReplied } from "./adapters/repo";
import { campaignKinds, campaignOnPlanApproved, campaignOnPlanCreated, createCampaigns } from "./index";

const { W, items, who, newTouch, newPost, newPerson } = await itemsWorld({ kinds: { ...factKinds(), ...planKinds({ onPlanApproved: campaignOnPlanApproved({ items: () => items }) }), ...campaignKinds(), ...replyDeskKind() } });
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
    { key: "page", on: "2026-11-06", title: "Landing page" },
  ],
  measures: [{ key: "m", label: "Meetings", target: "4", basis: { kind: "assumption" } }],
  budget: [],
  assumptions: [],
};
async function newCampaign() {
  const plan = await plans.createPlan(W, { title: "Q4", createdBy: person.userId });
  const { revision } = ok(await plans.savePlanDraft(W, plan.id, { revision: 0, body }));
  const { item } = ok(await plans.submitPlan(W, plan.id, { revision, actor }));
  ok(await items.approve(W, item.id, item.revision, who));
  const id = (await campaigns.list(W)).find((c) => c.planId === plan.id)!.id;
  ok(await campaigns.setupStep(W, id, "first", { type: "email", touchClass: "cold", mailboxCredentialId: null, audience: "everyone" }));
  ok(await campaigns.setupStep(W, id, "dm", { type: "dm", touchClass: "cold", mailboxCredentialId: null, audience: "everyone", dmChannel: "linkedin" }));
  ok(await campaigns.setupStep(W, id, "post", { type: "post", touchClass: null, mailboxCredentialId: null, audience: "everyone" }));
  return id;
}
async function join(id: string, personId?: string) {
  const p = personId ?? (await newPerson());
  await q("insert into campaign_people (workspace_id, campaign_id, person_id, added_by, at) values ($1, $2, $3, $4, now())", [W, id, p, person.userId]);
  return p;
}
/** An email Action of the step to this Person, sent unless said otherwise. */
async function email(id: string, personId: string, state = "sent") {
  const actionId = await actionIdOf(W, (await newTouch(personId, null)).id);
  await q("update actions set state = $1 where id = $2", [state, actionId]);
  await q("insert into campaign_actions (workspace_id, campaign_id, step_key, person_id, action_id) values ($1, $2, 'first', $3, $4)", [W, id, personId, actionId]);
  return actionId;
}
async function reply(personId: string, actionId: string, a: { status?: string; minutesAgo?: number } = {}) {
  const [row] = await q(
    "insert into reply_signals (workspace_id, event_id, sender_email, person_id, action_id, kind, status, text, received_at) values ($1, gen_random_uuid()::text, 'x@example.com', $2, $3, 'reply', $4, 'Sounds good', now() - make_interval(mins => $5)) returning id",
    [W, personId, actionId, a.status ?? "not_opt_out", a.minutesAgo ?? 0],
  );
  return row.id as string;
}
/** The reply desk's Item for a reply, replacing the one waiting in its thread, as the desk opens it. */
const label = async (personId: string, actionId: string, signalId: string, l: string) =>
  ok(
    await items.createItem(W, {
      kind: "reply",
      replace: true,
      payload: { signalId, thread: [signalId], personId, actionId, label: l, quote: null, owner: { userIds: [person.userId], rule: "workspace_owners" } },
      actor: { system: "outreach" },
      details: { title: "A reply", workArea: "outreach", channel: "email", groupKey: `reply:${personId}:${actionId}`, warnings: [] },
    }),
  );
const funnel = async (id: string) => (await campaigns.outcomes(W, id))!.steps;
const row = async (id: string, stepKey: string) => (await funnel(id)).find((s) => s.stepKey === stepKey)!;

test("every step has a row; an email step with nothing sent has no reply numbers, and DM, post and other steps never do", async () => {
  const id = await newCampaign();
  await email(id, await join(id), "needs_approval");
  expect(await funnel(id)).toEqual([
    { stepKey: "first", title: "First email", kind: "email", channel: "email", sent: { n: 0, source: "direx" }, replied: null, interested: null },
    { stepKey: "dm", title: "LinkedIn note", kind: "dm", channel: "linkedin", sent: { n: 0, source: "person" }, replied: null, interested: null },
    { stepKey: "post", title: "Launch post", kind: "post", channel: null, sent: { n: 0, source: "direx" }, replied: null, interested: null },
    { stepKey: "page", title: "Landing page", kind: "manual", channel: null, sent: null, replied: null, interested: null },
  ]);
});

test("DMs a person marked sent and published posts are counted on their step, and sends by channel still add up", async () => {
  const id = await newCampaign();
  const [a, b] = [await join(id), await join(id)];
  for (const [p, sent] of [[a, true], [b, false]] as const)
    await q("insert into campaign_dms (workspace_id, campaign_id, step_key, person_id, channel, profile_url, text, template_revision, created_at, sent_at, sent_by) values ($1, $2, 'dm', $3, 'linkedin', 'https://linkedin.com/in/x', 'Hi', 1, now(), $4, $5)", [W, id, p, sent ? new Date() : null, sent ? person.userId : null]);
  for (const state of ["sent", "needs_approval"]) {
    const post = await newPost();
    const actionId = await actionIdOf(W, post.id);
    await q("update actions set state = $1 where id = $2", [state, actionId]);
    await q("insert into social_posts (workspace_id, campaign_id, step_key, connection, network_id, item_id, action_id, created_at) values ($1, $2, 'post', 'linkedin', $3, $4, $5, now())", [W, id, state, post.id, actionId]);
  }
  const r = (await campaigns.outcomes(W, id))!;
  expect(r.sent).toEqual([{ kind: "post", channel: "linkedin", n: 1 }, { kind: "dm", channel: "linkedin", n: 1 }]);
  expect(r.steps.find((s) => s.stepKey === "dm")).toMatchObject({ sent: { n: 1, source: "person" }, replied: null });
  expect(r.steps.find((s) => s.stepKey === "post")).toMatchObject({ sent: { n: 1, source: "direx" }, replied: null });
  for (const key of ["dm", "post"]) {
    expect(await campaigns.setupStep(W, id, key, { type: "manual", touchClass: "cold", audience: "everyone" })).toEqual({ ok: false, reason: "step_has_results" });
  }
});

test("replies count People once, opt-outs included; interested counts a label later replaced", async () => {
  const id = await newCampaign();
  const [twice, optedOut, quiet] = [await join(id), await join(id), await join(id)];
  const toTwice = await email(id, twice);
  const toOptedOut = await email(id, optedOut);
  await email(id, quiet);
  expect(await row(id, "first")).toMatchObject({ sent: { n: 3, source: "direx" }, replied: { n: 0, source: "direx" }, interested: { n: 0, source: "direx" } });

  const older = await reply(twice, toTwice, { minutesAgo: 60 });
  await label(twice, toTwice, older, "interested");
  // A newer reply in the thread replaces the Item and its label; the Person was still interested once.
  const newer = await reply(twice, toTwice);
  await label(twice, toTwice, newer, "not_now");
  expect(await q("select state, payload->>'label' as label from items where kind = 'reply' and group_key = $1 order by created_at", [`reply:${twice}:${toTwice}`])).toEqual([
    { state: "cancelled", label: "interested" },
    { state: "needs_approval", label: "not_now" },
  ]);
  await reply(optedOut, toOptedOut, { status: "opted_out" });
  expect(await row(id, "first")).toMatchObject({ replied: { n: 2, source: "direx" }, interested: { n: 1, source: "direx" } });
});

test("a reply to another Campaign's email counts there, not here, though it stops this Campaign too", async () => {
  const here = await newCampaign();
  const there = await newCampaign();
  const p = await join(here);
  await join(there, p);
  await email(here, p);
  const theirs = await email(there, p);
  await reply(p, theirs);
  expect(await inWorkspace(W, (tx) => markReplied(tx, p))).toHaveLength(2);

  const r = (await campaigns.outcomes(W, here))!;
  // The Replied tile still counts this Campaign's People stopped by a reply anywhere.
  expect(r.email).toMatchObject({ replied: 1 });
  expect(r.steps[0]).toMatchObject({ replied: { n: 0, source: "direx" } });
  expect(await row(there, "first")).toMatchObject({ replied: { n: 1, source: "direx" } });
});

test("another Workspace's rows never count, even an Item that names this Workspace's email", async () => {
  const id = await newCampaign();
  const p = await join(id);
  const actionId = await email(id, p);
  const other = crypto.randomUUID();
  await seedMember(other, person.userId);
  await q(
    "insert into items (workspace_id, kind, state, title, warnings, payload, created_at, updated_at) values ($1, 'reply', 'needs_approval', 'A reply', '[]'::jsonb, $2, now(), now())",
    [other, { personId: p, actionId, label: "interested" }],
    other,
  );
  expect(await row(id, "first")).toMatchObject({ replied: { n: 0, source: "direx" }, interested: { n: 0, source: "direx" } });
  expect(await campaigns.outcomes(other, id)).toBeUndefined();
});

test("a sent email keeps its type and reply results when a DM setup is requested", async () => {
  const id = await newCampaign();
  const p = await join(id);
  const action = await email(id, p);
  await label(p, action, await reply(p, action), "interested");
  expect(await campaigns.setupStep(W, id, "first", { type: "dm", touchClass: "cold", audience: "everyone", dmChannel: "linkedin" })).toEqual({ ok: false, reason: "step_has_results" });
  ok(await campaigns.setupStep(W, id, "first", { type: "email", touchClass: "cold", audience: "everyone" }));
  expect(await row(id, "first")).toMatchObject({ kind: "email", sent: { n: 1 }, replied: { n: 1 }, interested: { n: 1 } });
});

test("an unsent step can change type", async () => {
  const id = await newCampaign();
  ok(await campaigns.setupStep(W, id, "first", { type: "dm", touchClass: "cold", audience: "everyone", dmChannel: "linkedin" }));
  expect(await row(id, "first")).toMatchObject({ kind: "dm", sent: { n: 0, source: "person" } });
});

test("a removed step keeps its latest historical title and recorded results", async () => {
  const id = await newCampaign();
  await email(id, await join(id));
  const planId = (await campaigns.campaign(W, id))!.planId;
  for (const steps of [body.steps.map((s) => s.key === "first" ? { ...s, title: "Renamed email" } : s), body.steps.filter((s) => s.key !== "first")]) {
    const plan = (await plans.plan(W, planId))!;
    const { revision } = ok(await plans.savePlanDraft(W, planId, { revision: plan.draftRevision, body: { ...body, steps } }));
    const { item } = ok(await plans.submitPlan(W, planId, { revision, actor }));
    ok(await items.approve(W, item.id, item.revision, who));
  }
  expect(await row(id, "first")).toMatchObject({ title: "Renamed email", kind: "email", sent: { n: 1 } });
  expect((await campaigns.campaign(W, id))!.steps.find((s) => s.key === "first")).toMatchObject({ title: "Renamed email", inPlan: false });
});
