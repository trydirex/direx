// SPDX-License-Identifier: AGPL-3.0-only
// A plan changed while its Campaign runs: real plans, Items, ledger and floors, through the real Gmail
// plugin to a fake Gmail. Text, channel and removed steps hold until a person chooses; dates move alone.
import { createGmailPlugin } from "@direx/extensions";
import { startFakeGmail } from "@direx/extensions/gmail/fake";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, expect, test } from "vitest";
import { appClient, ownerClient } from "../../../../../test/db";
import { createVault, credentialLabel, credentialReady, rootKeyFromEnv } from "../credentials/index";
import { createFacts, factKinds, describeFactChange, factVersion } from "../facts/index";
import { approverMayApprove, workspaceLive } from "../identity/index";
import { createItems, itemRoutes } from "../items/index";
import { passMailboxCheck, TEST_SECRET, testIdentity, testLedger } from "../outreach/fixtures/support";
import { createOutreach, outreachFloors } from "../outreach/index";
import { createPlans, planKinds, type PlanBody } from "../plans/index";
import { loadPlugins } from "../plugins/index";
import { touchCheck } from "../schedule/index";
import { MANUAL_POST, socialKinds } from "../social/index";
import { campaignCheck, campaignKinds, campaignOnPlanApproved, campaignOnPlanCreated, createCampaigns, stepOutputVersion, templateVersion, type Campaigns } from "./index";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;

const SEND = "com.trydirex.gmail/email.send";
const fake = startFakeGmail();
afterAll(() => fake.stop());
const plugins = loadPlugins({
  sources: [{ mode: "in_process", plugin: createGmailPlugin({ baseUrl: fake.url, timeoutMs: 1000 }) }],
  credentials: async () => ({ accessToken: fake.token, expiresAt: "" }),
  confinement: "none",
  log: () => {},
});
const { clock, ledger } = await testLedger({
  effects: plugins.effects,
  resolvers: { credential: credentialLabel, fact: factVersion, template: templateVersion, step_output: stepOutputVersion },
  checks: [workspaceLive(), outreachFloors(async () => true, () => clock.at), campaignCheck(), approverMayApprove(), touchCheck({ effects: plugins.effects, now: () => clock.at }), credentialReady],
  now: () => clock.at,
});
const now = () => clock.at;
let campaigns: Campaigns;
const items = createItems({
  ledger,
  now,
  kinds: { ...factKinds(), ...planKinds({ now, onPlanApproved: campaignOnPlanApproved({ now, items: () => items }) }), ...campaignKinds({ now }), ...socialKinds() },
  describeChange: describeFactChange,
  onApplied: (workspaceId, item) => campaigns.planApplied(workspaceId, item),
});
const outreach = createOutreach({
  items: () => items,
  send: () => ({ id: SEND, dedupe: "queryable", prepare: (ws, input) => plugins.prepare(ws, SEND, input) }),
  baseUrl: () => "https://direx.example",
  ledger: () => ledger,
  now,
});
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
campaigns = createCampaigns({ plans, facts, items: () => items, outreach: () => outreach, startDraft: () => async () => ({ ok: false, reason: "not_here" }), now });

const { routes, signIn, createOrg, call } = testIdentity();
(routes as unknown as OpenAPIHono).route("/", itemRoutes({ items: () => items }));
const cookie = await signIn();
const W = (await createOrg(cookie, "Acme")).workspace.id;

const db = await appClient();
afterAll(() => db.end());
async function q(text: string, params: unknown[] = []) {
  await db.query("begin");
  await db.query("select set_config('app.workspace_id', $1, true)", [W]);
  const r = await db.query(text, params);
  await db.query("commit");
  return r.rows;
}
const owner = (await q("select user_id from workspace_members"))[0].user_id as string;
const actor = { userId: owner };
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};

const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now });
const created = await vault.create({ workspaceId: W, actorUserId: owner, scope: "workspace", kind: "api_key", key: "me@acme.test", name: "me", meta: {}, value: { key: "x" } });
if (!created.ok) throw new Error(created.reason);
const mailbox = created.credential.id;
await q("update credentials set kind = 'oauth2', scope = 'user', owner_user_id = $1, connection = 'google' where id = $2", [owner, mailbox]);
await passMailboxCheck(W, mailbox);
await outreach.saveIdentity(W, { senderName: "Sam at Acme", postalAddress: "1 Main St" });

async function approve(item: { id: string }) {
  const { item: fresh } = (await (await call(`/api/w/${W}/items/${item.id}`, cookie)).json()) as { item: { revision: number } };
  return call(`/api/w/${W}/items/${item.id}/approve`, cookie, { method: "POST", body: { revision: fresh.revision } });
}

const saved = ok(
  await plans.saveStrategyDraft(W, {
    revision: 0,
    body: { schemaVersion: 1, whoFor: "Ops", personas: [], positioning: "Audit", channels: [{ key: "email", label: "Email", timing: "now", reason: "Read", basis: { kind: "assumption" } }], assumptions: [] },
  }),
);
expect((await approve(ok(await plans.submitStrategy(W, { revision: saved.revision, actor })).item)).status).toBe(200);

const ON = "2026-11-03";
const TEXT = { subject: "Hi {{firstName}}", text: "Hello {{firstName}} at {{company}}, from {{senderName}}.", citations: [] };
const NEW_TEXT = { subject: "Hi {{firstName}}", text: "New words for {{company}}.", citations: [] };
const body: PlanBody = {
  schemaVersion: 1,
  goal: "4 meetings",
  audience: "Ops",
  startsOn: "2026-11-02",
  endsOn: "2026-11-30",
  steps: [
    { key: "first", on: ON, channelKey: "email", title: "First", template: TEXT },
    { key: "second", on: "2026-11-10", channelKey: "email", title: "Second" },
  ],
  measures: [{ key: "m", label: "Meetings", target: "4", basis: { kind: "assumption" } }],
  budget: [],
  assumptions: [],
};
const withStep = (key: string, over: Partial<PlanBody["steps"][number]>, b: PlanBody = body): PlanBody => ({ ...b, steps: b.steps.map((s) => (s.key === key ? { ...s, ...over } : s)) });

/** Saves `next` as the plan's draft, submits it and approves it. */
async function approvePlan(planId: string, next: PlanBody) {
  const plan = (await plans.plan(W, planId))!;
  const { revision } = ok(await plans.savePlanDraft(W, planId, { revision: plan.draftRevision, body: next }));
  expect((await approve(ok(await plans.submitPlan(W, planId, { revision, actor })).item)).status).toBe(200);
}
/** A Campaign whose first step has its plan's text and one approved email to one Person. */
async function going() {
  const plan = await plans.createPlan(W, { title: "Q4", createdBy: owner });
  await approvePlan(plan.id, body);
  const id = (await campaigns.list(W)).find((c) => c.planId === plan.id)!.id;
  ok(await campaigns.setDraftingMode(W, id, "template"));
  ok(await campaigns.setupStep(W, id, "first", { type: "email", touchClass: "cold", mailboxCredentialId: mailbox, audience: "everyone" }));
  ok(await campaigns.addPeople(W, id, { csv: `email,first_name,company,country,basis,evidence\n${crypto.randomUUID()}@acme.test,Kim,Acme,US,published_address,Their contact page`, userId: owner }));
  const itemId = ok(await campaigns.makeDrafts(W, id, "first", { timeZone: "UTC", userId: owner })).results[0]!.itemId!;
  expect((await approve({ id: itemId })).status).toBe(200);
  const action = (await q("select action_id from items where id = $1", [itemId]))[0].action_id as string;
  return { id, planId: plan.id, itemId, action };
}
const atSendTime = async <T>(fn: () => Promise<T>) => {
  const start = clock.at;
  clock.at = new Date(`${ON}T12:00:00Z`);
  try {
    return await fn();
  } finally {
    clock.at = start;
  }
};
const changesOf = (id: string) => q("select step_key, from_version, to_version, kinds, suggested_template, decided from campaign_plan_changes where campaign_id = $1 order by step_key", [id]);
const choicesOf = (id: string) => q("select id, state, title from items where kind = 'plan_change' and payload->>'campaignId' = $1 order by created_at", [id]);
const stepOf = async (id: string, key: string) => (await q("select template, template_revision from campaign_steps where campaign_id = $1 and step_key = $2", [id, key]))[0];
const plannedOf = async (itemId: string) => (await q("select planned_at from items where id = $1", [itemId]))[0].planned_at as Date;

test("an undecided plan change holds its step's approved email at claim; another step's change or a decided one doesn't", async () => {
  const [held, other, decided] = [await going(), await going(), await going()];
  const planChanged = (id: string, stepKey: string, itemId: string) =>
    q("insert into campaign_plan_changes (workspace_id, campaign_id, step_key, from_version, to_version, kinds, item_id) values ($1, $2, $3, 1, 2, '{removed}', $4)", [W, id, stepKey, itemId]);
  await planChanged(held.id, "first", held.itemId);
  await planChanged(other.id, "second", other.itemId);
  await planChanged(decided.id, "first", decided.itemId);
  await q("update campaign_plan_changes set decided = 'keep', decided_by = $1, decided_at = now() where campaign_id = $2", [owner, decided.id]);
  const before = fake.sent.length;
  await atSendTime(() => ledger.run(W, held.action));
  expect(await items.view(W, held.itemId)).toMatchObject({ state: "held", reasonCode: "plan_changed", reason: "the plan changed" });
  expect(fake.sent).toHaveLength(before);
  await atSendTime(() => ledger.run(W, other.action));
  expect(await items.view(W, other.itemId)).toMatchObject({ state: "sent" });
  await atSendTime(() => ledger.run(W, decided.action));
  expect(await items.view(W, decided.itemId)).toMatchObject({ state: "sent" });
  expect(fake.sent).toHaveLength(before + 2);
});

test("new plan text for a step that has text is only suggested, and holds the step until a person chooses", async () => {
  const g = await going();
  const before = await stepOf(g.id, "first");
  await approvePlan(g.planId, withStep("first", { template: NEW_TEXT }));
  expect(await stepOf(g.id, "first")).toEqual(before);
  expect(await changesOf(g.id)).toEqual([{ step_key: "first", from_version: 1, to_version: 2, kinds: ["text"], suggested_template: NEW_TEXT, decided: null }]);
  const [choice] = await choicesOf(g.id);
  expect(choice).toMatchObject({ state: "needs_approval", title: 'The plan changed "First": keep its text, use the new text, or cancel the step' });
  expect((await items.view(W, choice!.id))!.decideBy).toEqual(await plannedOf(g.itemId));
  await atSendTime(() => ledger.run(W, g.action));
  expect(await items.view(W, g.itemId)).toMatchObject({ state: "held", reasonCode: "plan_changed" });
});

test("a step given new text and a later date is due by its moved first email", async () => {
  const g = await going();
  const was = await plannedOf(g.itemId);
  await approvePlan(g.planId, withStep("first", { template: NEW_TEXT, on: "2026-11-05" }));
  const [choice] = await choicesOf(g.id);
  expect((await plannedOf(g.itemId)).getTime() - was.getTime()).toBe(2 * 86_400_000);
  expect((await items.view(W, choice!.id))!.decideBy).toEqual(await plannedOf(g.itemId));
});

test("a choice can't be dismissed: its step keeps waiting for a person's answer", async () => {
  const g = await going();
  await approvePlan(g.planId, withStep("first", { template: NEW_TEXT }));
  const [choice] = await choicesOf(g.id);
  expect(await items.cancel(W, choice!.id, actor)).toEqual({ ok: false, reason: "choice_required" });
  expect(await choicesOf(g.id)).toMatchObject([{ state: "needs_approval" }]);
  expect(await changesOf(g.id)).toMatchObject([{ decided: null }]);
});

test("a removed step or a changed channel holds it", async () => {
  const removed = await going();
  await approvePlan(removed.planId, { ...body, steps: body.steps.filter((s) => s.key !== "first") });
  expect(await changesOf(removed.id)).toMatchObject([{ step_key: "first", kinds: ["removed"], suggested_template: null }]);
  expect(await choicesOf(removed.id)).toMatchObject([{ title: 'The plan removed "First": finish what\'s scheduled or cancel the step' }]);
  const moved = await going();
  await approvePlan(moved.planId, withStep("first", { channelKey: "linkedin" }));
  expect(await changesOf(moved.id)).toMatchObject([{ step_key: "first", kinds: ["channel"] }]);
});

test("a later date moves the step's emails with their approval and holds nothing; a title, goal or audience change does nothing", async () => {
  const g = await going();
  const was = await plannedOf(g.itemId);
  await approvePlan(g.planId, { ...withStep("first", { on: "2026-11-05", title: "Opening" }), goal: "5 meetings", audience: "Ops leads" });
  expect(await changesOf(g.id)).toEqual([]);
  expect(await choicesOf(g.id)).toEqual([]);
  expect((await plannedOf(g.itemId)).getTime() - was.getTime()).toBe(2 * 86_400_000);
  expect(await items.view(W, g.itemId)).toMatchObject({ state: "scheduled" });
});

test("an email step with no text yet takes the new plan text, and nothing holds", async () => {
  const g = await going();
  ok(await campaigns.setupStep(W, g.id, "second", { type: "email", touchClass: "cold", mailboxCredentialId: mailbox, audience: "everyone" }));
  expect(await stepOf(g.id, "second")).toEqual({ template: null, template_revision: 0 });
  await approvePlan(g.planId, withStep("second", { template: NEW_TEXT }));
  expect(await stepOf(g.id, "second")).toMatchObject({ template: { subject: NEW_TEXT.subject, text: NEW_TEXT.text }, template_revision: 1 });
  expect(await changesOf(g.id)).toEqual([]);
});

test("a second version before anyone chooses replaces the step's change, and one restoring its text closes it and resumes its emails", async () => {
  const g = await going();
  await approvePlan(g.planId, withStep("first", { template: NEW_TEXT }));
  const third = { ...NEW_TEXT, text: "Third words for {{company}}." };
  await approvePlan(g.planId, withStep("first", { template: third }));
  expect(await changesOf(g.id)).toMatchObject([{ from_version: 1, to_version: 3, kinds: ["text"], suggested_template: third, decided: null }]);
  expect((await choicesOf(g.id)).map((c) => c.state)).toEqual(["needs_approval"]);
  await atSendTime(() => ledger.run(W, g.action));
  expect(await items.view(W, g.itemId)).toMatchObject({ state: "held", reasonCode: "plan_changed" });

  await approvePlan(g.planId, body);
  expect(await changesOf(g.id)).toMatchObject([{ to_version: 3, decided: "keep" }]);
  expect((await choicesOf(g.id)).map((c) => c.state)).toEqual(["cancelled"]);
  await atSendTime(() => ledger.run(W, g.action));
  expect(await items.view(W, g.itemId)).toMatchObject({ state: "sent" });
});

const choose = async (choiceId: string, choice: string) => {
  const { item: fresh } = (await (await call(`/api/w/${W}/items/${choiceId}`, cookie)).json()) as { item: { revision: number } };
  return items.approve(W, choiceId, fresh.revision, { approverId: owner as never, may: () => true } as never, choice);
};
/** A Campaign whose first step the plan gave new text, with its email already held for it. */
async function heldForText() {
  const g = await going();
  await approvePlan(g.planId, withStep("first", { template: NEW_TEXT }));
  await atSendTime(() => ledger.run(W, g.action));
  expect(await items.view(W, g.itemId)).toMatchObject({ state: "held", reasonCode: "plan_changed" });
  return { ...g, choiceId: (await choicesOf(g.id))[0]!.id as string };
}

test("keep: the held email goes again with its approval, and later claims of the step aren't held", async () => {
  const g = await heldForText();
  expect(await choose(g.choiceId, "keep")).toMatchObject({ ok: true });
  expect(await changesOf(g.id)).toMatchObject([{ decided: "keep" }]);
  expect(await items.view(W, g.itemId)).toMatchObject({ state: "scheduled" });
  await atSendTime(() => ledger.run(W, g.action));
  expect(await items.view(W, g.itemId)).toMatchObject({ state: "sent" });
});

test("use the new text: the step takes it, and the same email is revised and needs approval again", async () => {
  const g = await heldForText();
  expect(await choose(g.choiceId, "use_new_text")).toMatchObject({ ok: true });
  expect(await stepOf(g.id, "first")).toMatchObject({ template: { text: NEW_TEXT.text }, template_revision: 2 });
  expect(await q("select action_id from items where id = $1", [g.itemId])).toEqual([{ action_id: g.action }]);
  expect(await items.view(W, g.itemId)).toMatchObject({ state: "needs_approval" });
  expect((await approve({ id: g.itemId })).status).toBe(200);
  await atSendTime(() => ledger.run(W, g.action));
  expect(await items.view(W, g.itemId)).toMatchObject({ state: "sent" });
});

test("cancel: the step is cancelled with its unsent emails and its posts copied by hand", async () => {
  const g = await heldForText();
  const post = ok(await items.createItem(W, { kind: MANUAL_POST, payload: { text: "By hand", followUps: [] }, actor, details: { title: "Later: First", workArea: "social", warnings: [] } }));
  await q("insert into social_posts (workspace_id, campaign_id, step_key, connection, network_id, item_id, created_at) values ($1, $2, 'first', 'later', '', $3, now())", [W, g.id, post.item.id]);
  expect(await choose(g.choiceId, "cancel")).toMatchObject({ ok: true });
  expect((await q("select cancelled_at from campaign_steps where campaign_id = $1 and step_key = 'first'", [g.id]))[0].cancelled_at).not.toBeNull();
  expect(await items.view(W, g.itemId)).toMatchObject({ state: "cancelled" });
  expect(await items.view(W, post.item.id)).toMatchObject({ state: "cancelled" });
});

test("using the new text is refused when the plan suggested none, and a choice is needed", async () => {
  const g = await going();
  await approvePlan(g.planId, { ...body, steps: body.steps.filter((s) => s.key !== "first") });
  const [choice] = await choicesOf(g.id);
  expect(await choose(choice!.id, "use_new_text")).toEqual({ ok: false, reason: "choice_not_offered" });
  expect(await choose(choice!.id, "maybe")).toEqual({ ok: false, reason: "choice_required" });
  expect(await changesOf(g.id)).toMatchObject([{ decided: null }]);
});

test("while the plan is edited, its impact counts each held step's emails by state, and the Campaign shows the step's change once approved", async () => {
  const g = await going();
  const plan = (await plans.plan(W, g.planId))!;
  ok(await plans.savePlanDraft(W, g.planId, { revision: plan.draftRevision, body: withStep("first", { template: NEW_TEXT, on: "2026-11-04" }) }));
  expect(await campaigns.planImpact(W, g.id)).toMatchObject({ affected: [{ key: "first", kinds: ["text"], counts: { scheduled: 1 } }], titles: { first: "First", second: "Second" } });
  expect((await campaigns.campaign(W, g.id))!.steps.find((s) => s.key === "first")!.planChange).toBeNull();

  await approvePlan(g.planId, withStep("first", { template: NEW_TEXT }));
  const [choice] = await choicesOf(g.id);
  expect((await campaigns.campaign(W, g.id))!.steps.find((s) => s.key === "first")!.planChange).toEqual({ kinds: ["text"], suggestedTemplate: { subject: NEW_TEXT.subject, text: NEW_TEXT.text }, itemId: choice!.id, expired: 0 });
  // Its slot passes while it waits: keeping it moves it to the next free one.
  await atSendTime(async () => expect((await campaigns.campaign(W, g.id))!.steps.find((s) => s.key === "first")!.planChange!.expired).toBe(1));
});

const settlementsOf = (id: string) => q("select key, attempts, settled_at is not null as settled from campaign_settlements where campaign_id = $1 order by key like 'choice:%', created_at", [id]);
const unfinishedOf = (id: string) => q("select id, state from items where kind = 'campaign_plan_unfinished' and payload->>'campaignId' = $1 order by created_at", [id]);

test("new text the step can't take yet stays owed: tried again, a person asked after three tries, and finished once it can", async () => {
  const g = await going();
  const claim = { ...NEW_TEXT, text: "Only $49 a month, {{firstName}}." };
  await approvePlan(g.planId, withStep("first", { template: claim }));
  const [choice] = await choicesOf(g.id);
  // A price Fact set after the plan was approved disagrees with its text, so the step can't take it while it stands.
  const price = await facts.set(W, { field: "price", value: "$99 a month", source: { kind: "person", label: "Sam" }, confidence: "high", actor });
  if (!price.ok) throw new Error(JSON.stringify(price));
  expect(await choose(choice!.id, "use_new_text")).toMatchObject({ ok: true });
  expect(await settlementsOf(g.id)).toEqual([
    { key: "plan:2", attempts: 0, settled: true },
    { key: `choice:${choice!.id}`, attempts: 1, settled: false },
  ]);
  expect(await stepOf(g.id, "first")).toMatchObject({ template: { text: TEXT.text } });

  await campaigns.settleAll();
  expect(await unfinishedOf(g.id)).toEqual([]);
  await campaigns.settleAll();
  await campaigns.settleAll();
  // Asked once, however many tries fail after the third.
  expect(await unfinishedOf(g.id)).toMatchObject([{ state: "needs_approval" }]);
  expect((await settlementsOf(g.id)).at(-1)).toMatchObject({ attempts: 4, settled: false });

  // Once that price is retired, trying again finishes the work.
  await facts.retire(W, price.id, actor);
  expect((await approve({ id: (await unfinishedOf(g.id))[0]!.id })).status).toBe(200);
  expect((await settlementsOf(g.id)).at(-1)).toMatchObject({ settled: true });
  expect(await stepOf(g.id, "first")).toMatchObject({ template: { text: claim.text } });
  expect(await items.view(W, g.itemId)).toMatchObject({ state: "needs_approval" });
});

test("owed moves done a second time move nothing twice, and the email keeps its approval", async () => {
  const g = await going();
  const was = await plannedOf(g.itemId);
  await approvePlan(g.planId, withStep("first", { on: "2026-11-05" }));
  expect((await plannedOf(g.itemId)).getTime() - was.getTime()).toBe(2 * 86_400_000);
  // As if the run stopped before recording that it finished.
  const c = await ownerClient();
  await c.query("update campaign_settlements set settled_at = null where campaign_id = $1", [g.id]).finally(() => c.end());
  await campaigns.settleAll();
  expect((await plannedOf(g.itemId)).getTime() - was.getTime()).toBe(2 * 86_400_000);
  expect(await items.view(W, g.itemId)).toMatchObject({ state: "scheduled" });
  expect(await settlementsOf(g.id)).toMatchObject([{ key: "plan:2", settled: true }]);
});
