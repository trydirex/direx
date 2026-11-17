// SPDX-License-Identifier: AGPL-3.0-only
// From a set-up Campaign to started work, through Needs you: real plans, Items, ledger, campaigns and
// the start queue, with only the model run faked. Nothing starts until a person accepts.
import { createGmailPlugin } from "@direx/extensions";
import { startFakeGmail } from "@direx/extensions/gmail/fake";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { campaignKinds, campaignOnPlanApproved, campaignOnPlanCreated, campaignOutsideReplies, campaignSinks, createCampaigns, stepOutputVersion, templateVersion } from "../campaigns/index";
import { createVault, credentialLabel, credentialReady, rootKeyFromEnv } from "../credentials/index";
import { createFacts, describeFactChange, factKinds, factVersion } from "../facts/index";
import { approverMayApprove, mayGrantRules, workspaceLive } from "../identity/index";
import { createItems, itemRoutes } from "../items/index";
import { passMailboxCheck, TEST_SECRET, testIdentity, testLedger } from "../outreach/fixtures/support";
import { createOutreach, createOutsideTouches, outreachFloors } from "../outreach/index";
import { createPlans, planKinds, type PlanBody } from "../plans/index";
import { loadPlugins } from "../plugins/index";
import { touchCheck } from "../schedule/index";
import { campaignCheck } from "../campaigns/index";
import { createNextSteps, NEXT_STEP_KIND } from "./index";

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
const { boss, clock, ledger } = await testLedger({
  effects: plugins.effects,
  resolvers: { credential: credentialLabel, fact: factVersion, template: templateVersion, step_output: stepOutputVersion },
  checks: [workspaceLive(), outreachFloors(async () => true, () => clock.at), campaignCheck(), approverMayApprove(), touchCheck({ effects: plugins.effects, now: () => clock.at }), credentialReady],
  now: () => clock.at,
});
const now = () => clock.at;

// The model run is the only fake: it records who started which step, or refuses when told to.
const started: { campaignId: string; stepKey: string; startedBy: string; trigger?: string }[] = [];
const runs: { refuse?: string } = {};
const startDraft = () => async (_workspaceId: string, a: { input: { target: { id: string | null; stepKey?: string } }; startedBy: string; trigger?: string }) => {
  if (runs.refuse) return { ok: false as const, reason: runs.refuse };
  started.push({ campaignId: a.input.target.id!, stepKey: a.input.target.stepKey!, startedBy: a.startedBy, ...(a.trigger && { trigger: a.trigger }) });
  return { ok: true as const, run: { id: crypto.randomUUID() } };
};

const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const nextSteps = createNextSteps({ items: () => items, campaigns: () => campaigns, plans, boss, now: () => new Date() });
const items = createItems({
  ledger,
  now,
  kinds: { ...factKinds(), ...planKinds({ now, onPlanApproved: campaignOnPlanApproved({ now, items: () => items }) }), ...campaignKinds({ now }), ...nextSteps.kinds() },
  describeChange: describeFactChange,
  onApplied: (w, i) => nextSteps.onApplied(w, i),
  mayGrant: mayGrantRules,
});
const outreach = createOutreach({
  items: () => items,
  send: () => ({ id: SEND, dedupe: "queryable", prepare: (ws, input) => plugins.prepare(ws, SEND, input) }),
  baseUrl: () => "https://direx.example",
  ledger: () => ledger,
  now,
});
const touches = createOutsideTouches({ replies: () => campaignOutsideReplies({ items: () => items }), now });
const shared = { plans, facts, items: () => items, outreach: () => outreach, outsideTouches: () => touches, startDraft: startDraft as never, now };
const campaigns = createCampaigns({ ...shared, onSetupChanged: (w, s) => nextSteps.onSetupChanged(w, s), onTemplateSaved: (w, s) => nextSteps.onTemplateSaved(w, s) });
// The same module with no hooks, for a change the cards never hear about.
const unhooked = createCampaigns(shared);
await nextSteps.work(boss);

const { routes, signIn, createOrg, call } = testIdentity();
(routes as unknown as OpenAPIHono).route("/", itemRoutes({ items: () => items }));
const cookie = await signIn();
const W = (await createOrg(cookie, "Acme")).workspace.id;

const db = await appClient();
afterAll(() => db.end());
const owner = await (async () => {
  await db.query("begin");
  await db.query("select set_config('app.workspace_id', $1, true)", [W]);
  const r = await db.query("select user_id from workspace_members");
  await db.query("commit");
  return r.rows[0].user_id as string;
})();
const actor = { userId: owner };
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};

const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now });
const created = await vault.create({ workspaceId: W, actorUserId: owner, scope: "workspace", kind: "api_key", key: "me@acme.test", name: "me", meta: {}, value: { key: "x" } });
if (!created.ok) throw new Error(created.reason);
await db.query("begin");
await db.query("select set_config('app.workspace_id', $1, true)", [W]);
await db.query("update credentials set kind = 'oauth2', scope = 'user', owner_user_id = $1, connection = 'google' where id = $2", [owner, created.credential.id]);
await db.query("commit");
const mailbox = created.credential.id;
await passMailboxCheck(W, mailbox);
await outreach.saveIdentity(W, { senderName: "Sam at Acme", postalAddress: "1 Main St" });

async function approve(id: string, choice?: string) {
  const { item } = (await (await call(`/api/w/${W}/items/${id}`, cookie)).json()) as { item: { revision: number } };
  return call(`/api/w/${W}/items/${id}/approve`, cookie, { method: "POST", body: { revision: item.revision, ...(choice !== undefined && { choice }) } });
}
const saved = ok(
  await plans.saveStrategyDraft(W, {
    revision: 0,
    body: { schemaVersion: 1, whoFor: "Ops", personas: [], positioning: "Audit", channels: [{ key: "email", label: "Email", timing: "now", reason: "Read", basis: { kind: "assumption" } }], assumptions: [] },
  }),
);
expect((await approve(ok(await plans.submitStrategy(W, { revision: saved.revision, actor })).item.id)).status).toBe(200);

const body: PlanBody = {
  schemaVersion: 1,
  goal: "4 meetings",
  audience: "Ops",
  startsOn: "2026-11-02",
  endsOn: "2026-11-30",
  steps: [
    { key: "first", on: "2026-11-03", title: "First email" },
    { key: "second", on: "2026-11-10", title: "Second" },
  ],
  measures: [{ key: "m", label: "Meetings", target: "4", basis: { kind: "assumption" } }],
  budget: [],
  assumptions: [],
};

/** A live Next step for one Campaign, with its payload, or null. */
async function card(campaignId: string, link: string) {
  const listed = (await items.list(W, { needsYou: true, offset: 0, limit: 500 })).items.filter((i) => i.kind === NEXT_STEP_KIND && i.groupKey?.startsWith(`${link}:${campaignId}`));
  expect(listed.length).toBeLessThanOrEqual(1);
  if (!listed[0]) return null;
  const seen = (await items.detail(W, listed[0].id))!;
  return { id: listed[0].id, title: listed[0].title, warnings: listed[0].warnings, payload: seen.content as Record<string, unknown> };
}
async function until<T>(check: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    const v = await check();
    if (v) return v;
  }
  throw new Error("timed out");
}

async function approvedPlan() {
  const plan = await plans.createPlan(W, { title: `Q4 ${crypto.randomUUID().slice(0, 4)}`, createdBy: owner });
  const { revision } = ok(await plans.savePlanDraft(W, plan.id, { revision: 0, body }));
  expect((await approve(ok(await plans.submitPlan(W, plan.id, { revision, actor })).item.id)).status).toBe(200);
  return (await campaigns.list(W)).find((c) => c.planId === plan.id)!;
}
async function setUp(campaignId: string) {
  ok(await campaigns.setDraftingMode(W, campaignId, "template"));
  ok(await campaigns.setupStep(W, campaignId, "first", { type: "email", touchClass: "cold", mailboxCredentialId: mailbox, audience: "everyone" }));
}
const TEMPLATE = { subject: "Hi {{firstName}}", text: "Hello {{firstName}} at {{company}}, from {{senderName}}." };
const addPeople = (campaignId: string, n: number) =>
  campaigns.addPeople(W, campaignId, {
    csv: `email,first_name,company,country,basis,evidence\n${Array.from({ length: n }, () => `${crypto.randomUUID()}@acme.test,Dana,Acme,US,published_address,Their contact page`).join("\n")}`,
    userId: owner,
  });

test("a plan approval offers nothing while no step can draft; setting the Campaign up offers its text, and Start drafts it as the accepter", async () => {
  const c = await approvedPlan();
  expect(await card(c.id, "plan_to_templates")).toBeNull();
  await setUp(c.id);
  const offered = (await card(c.id, "plan_to_templates"))!;
  expect(offered.title).toBe(`Draft the text for 1 step in ${c.title}`);
  expect(offered.payload).toMatchObject({ link: "plan_to_templates", campaignId: c.id, stepKeys: ["first"] });
  expect(started.filter((s) => s.campaignId === c.id)).toEqual([]);

  expect((await approve(offered.id)).status).toBe(200);
  expect(await until(async () => started.find((s) => s.campaignId === c.id))).toEqual({ campaignId: c.id, stepKey: "first", startedBy: owner });
  expect(await card(c.id, "plan_to_templates")).toBeNull();
});

test("a saved template offers that step's drafts; Start makes them in the accepter's time zone", async () => {
  const c = await approvedPlan();
  await setUp(c.id);
  ok(await addPeople(c.id, 3));
  ok(await campaigns.saveTemplate(W, c.id, "first", { revision: 0, ...TEMPLATE, userId: owner }));
  const offered = (await card(c.id, "template_to_drafts"))!;
  expect(offered.title).toBe(`Make drafts for First email in ${c.title}: 3 People`);

  expect((await approve(offered.id, "Mars/Olympus")).status).toBe(409);
  expect((await approve(offered.id)).status).toBe(409);
  expect((await approve(offered.id, "Europe/London")).status).toBe(200);
  await until(async () => (await campaigns.previewDrafts(W, c.id, "first")).ok && ok(await campaigns.previewDrafts(W, c.id, "first")).already === 3);
});

test("a template written by a drafting run offers the drafts card once, with no Save needed", async () => {
  const c = await approvedPlan();
  await setUp(c.id);
  ok(await addPeople(c.id, 2));
  const asked = ok(await campaigns.draftInput(W, c.id, "first"));
  const { draft } = campaignSinks({ facts, now, onTemplateSaved: (w, s) => nextSteps.onTemplateSaved(w, s) });
  const proposal = { kind: "draft" as const, outputKey: "template", body: { ...TEMPLATE, citations: [] } };
  const context = { runId: crypto.randomUUID(), input: asked.input, tainted: false, pagesRead: [], pages: [], producer: { agent: "test", definitionVersion: 1, promptDigest: "d", routeHash: "r" } };

  expect(await draft(W, proposal, context)).toEqual({ ok: true, itemId: null });
  const offered = (await card(c.id, "template_to_drafts"))!;
  expect(offered.title).toBe(`Make drafts for First email in ${c.title}: 2 People`);
  expect(offered.payload.templateRevision).toBe(1);
  // The same hand-over again writes nothing, so the card stays the one it was.
  expect(await draft(W, proposal, context)).toEqual({ ok: true, itemId: null });
  expect((await card(c.id, "template_to_drafts"))!.id).toBe(offered.id);
});

test("a step written with Write it for me closes the Draft the text card waiting for it", async () => {
  const c = await approvedPlan();
  await setUp(c.id);
  const waiting = (await card(c.id, "plan_to_templates"))!;
  const asked = ok(await campaigns.draftInput(W, c.id, "first"));
  const { draft } = campaignSinks({ facts, now, onTemplateSaved: (w, s) => nextSteps.onTemplateSaved(w, s) });
  const context = { runId: crypto.randomUUID(), input: asked.input, tainted: false, pagesRead: [], pages: [], producer: { agent: "test", definitionVersion: 1, promptDigest: "d", routeHash: "r" } };

  expect(await draft(W, { kind: "draft" as const, outputKey: "template", body: { ...TEMPLATE, citations: [] } }, context)).toEqual({ ok: true, itemId: null });
  expect(await card(c.id, "plan_to_templates")).toBeNull();
  expect((await items.detail(W, waiting.id))?.item.state).toBe("cancelled");
});

test("saving the template again replaces the card, and a card whose template moved on starts nothing", async () => {
  const c = await approvedPlan();
  await setUp(c.id);
  ok(await addPeople(c.id, 1));
  ok(await campaigns.saveTemplate(W, c.id, "first", { revision: 0, ...TEMPLATE, userId: owner }));
  const first = (await card(c.id, "template_to_drafts"))!;
  ok(await campaigns.saveTemplate(W, c.id, "first", { revision: 1, ...TEMPLATE, userId: owner }));
  const second = (await card(c.id, "template_to_drafts"))!;
  expect(second.id).not.toBe(first.id);
  expect(second.payload.templateRevision).toBe(2);
  expect((await items.detail(W, first.id))?.item.state).toBe("cancelled");

  ok(await unhooked.saveTemplate(W, c.id, "first", { revision: 2, ...TEMPLATE, userId: owner }));
  const refused = await approve(second.id, "Europe/London");
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: "moved_on" });
  expect((await campaigns.previewDrafts(W, c.id, "first")).ok && ok(await campaigns.previewDrafts(W, c.id, "first")).already).toBe(0);
});

/** Who changed a card's state last, as its history says. */
const lastBy = async (id: string) => (await items.detail(W, id))!.timeline.at(-1)!.actor;
const ZONE = "America/Vancouver";

test("under run, a set-up Campaign starts its text as the person who chose run, with no Start pressed", async () => {
  const c = await approvedPlan();
  ok(await campaigns.setAdvance(W, c.id, { advance: "run", timeZone: ZONE, userId: owner }));
  await setUp(c.id);
  expect(await until(async () => started.find((s) => s.campaignId === c.id))).toEqual({ campaignId: c.id, stepKey: "first", startedBy: owner, trigger: "advance" });
  // The card is Applied, and its history names the grant rather than a press.
  const applied = (await items.list(W, { offset: 0, limit: 500 })).items.find((i) => i.kind === NEXT_STEP_KIND && i.groupKey === `plan_to_templates:${c.id}`)!;
  expect(applied.state).toBe("applied");
  expect(await lastBy(applied.id)).toEqual({ kind: "system", id: "campaign_advance" });
});

test("under run, a saved template makes its drafts in the zone chosen with run", async () => {
  const c = await approvedPlan();
  await setUp(c.id);
  ok(await addPeople(c.id, 2));
  ok(await campaigns.setAdvance(W, c.id, { advance: "run", timeZone: ZONE, userId: owner }));
  ok(await campaigns.saveTemplate(W, c.id, "first", { revision: 0, ...TEMPLATE, userId: owner }));
  expect(await card(c.id, "template_to_drafts")).toBeNull();
  await until(async () => (await campaigns.previewDrafts(W, c.id, "first")).ok && ok(await campaigns.previewDrafts(W, c.id, "first")).already === 2);
});

test("turning run on starts a card already waiting; turning it off leaves the next one waiting", async () => {
  const c = await approvedPlan();
  await setUp(c.id);
  const waiting = (await card(c.id, "plan_to_templates"))!;
  ok(await campaigns.setAdvance(W, c.id, { advance: "run", timeZone: ZONE, userId: owner }));
  await until(async () => started.find((s) => s.campaignId === c.id && s.trigger === "advance"));
  expect((await items.detail(W, waiting.id))?.item.state).toBe("cancelled");

  ok(await campaigns.setAdvance(W, c.id, { advance: "offer", timeZone: null, userId: owner }));
  ok(await addPeople(c.id, 1));
  ok(await campaigns.saveTemplate(W, c.id, "first", { revision: 0, ...TEMPLATE, userId: owner }));
  expect((await card(c.id, "template_to_drafts"))?.title).toBe(`Make drafts for First email in ${c.title}: 1 Person`);
});

test("under run, a start that keeps failing comes back once as a waiting card", async () => {
  const c = await approvedPlan();
  ok(await campaigns.setAdvance(W, c.id, { advance: "run", timeZone: ZONE, userId: owner }));
  runs.refuse = "no_route";
  try {
    await setUp(c.id);
    const again = await until(async () => {
      const next = await card(c.id, "plan_to_templates");
      return next?.warnings.length ? next : null;
    });
    expect(again.warnings.map((w) => w.text)).toEqual(["Couldn't start last time: no_route"]);
    expect((await items.detail(W, again.id))?.item.state).toBe("needs_approval");
  } finally {
    delete runs.refuse;
  }
});

test("a grant from someone who can no longer give it applies nothing", async () => {
  const c = await approvedPlan();
  await setUp(c.id);
  const waiting = (await card(c.id, "plan_to_templates"))!;
  expect(await items.applyByGrant(W, waiting.id, { userId: crypto.randomUUID(), as: "campaign_advance" })).toEqual({ ok: false, reason: "forbidden" });
  expect((await items.detail(W, waiting.id))?.item.state).toBe("needs_approval");
});

test("run needs a real time zone", async () => {
  const c = await approvedPlan();
  expect(await campaigns.setAdvance(W, c.id, { advance: "run", timeZone: "Mars/Olympus", userId: owner })).toEqual({ ok: false, reason: "bad_time_zone" });
  expect((await campaigns.campaign(W, c.id))?.advance).toBe("offer");
});

test("when the start is refused, the card comes back with the reason", async () => {
  const c = await approvedPlan();
  await setUp(c.id);
  const offered = (await card(c.id, "plan_to_templates"))!;
  runs.refuse = "no_route";
  try {
    expect((await approve(offered.id)).status).toBe(200);
    const again = await until(async () => {
      const next = await card(c.id, "plan_to_templates");
      return next && next.id !== offered.id ? next : null;
    });
    expect(again.warnings.map((w) => w.text)).toEqual(["Couldn't start last time: no_route"]);
  } finally {
    delete runs.refuse;
  }
});

test("a per-Person follow-up is due 2 days before its date, and its card drafts it in the accepter's zone", async () => {
  const c = await approvedPlan();
  ok(await campaigns.setDraftingMode(W, c.id, "per_person"));
  for (const key of ["first", "second"]) ok(await campaigns.setupStep(W, c.id, key, { type: "email", touchClass: "cold", mailboxCredentialId: mailbox, audience: "everyone" }));
  ok(await addPeople(c.id, 2));
  const dueHere = async () => (await campaigns.followUpsDue()).filter((d) => d.campaignId === c.id);
  const before = clock.at;
  try {
    // "second" is on 10 Nov, so it is due from 8 Nov; the first email step is drafted on import, never here.
    clock.at = new Date("2026-11-07T09:00:00Z");
    expect(await dueHere()).toEqual([]);
    clock.at = new Date("2026-11-08T09:00:00Z");
    expect(await dueHere()).toEqual([{ workspaceId: W, campaignId: c.id, stepKey: "second" }]);
  } finally {
    clock.at = before;
  }

  await nextSteps.offerFollowUp(W, c.id, "second");
  const offered = (await card(c.id, "due_to_drafts"))!;
  expect(offered.title).toBe(`Draft follow-ups for Second in ${c.title}: 2 People`);
  // Second goes Tue 10 Nov: a working day to approve and a day of drafting before that.
  expect((await items.view(W, offered.id))!.decideBy).toEqual(new Date("2026-11-08T09:00:00Z"));
  expect((await approve(offered.id)).status).toBe(409);
  expect((await approve(offered.id, "Europe/London")).status).toBe(200);
  expect(await until(async () => started.filter((s) => s.campaignId === c.id && s.stepKey === "second").length === 2 || null)).toBe(true);
});

test("a follow-up card that stopped being per Person starts nothing", async () => {
  const c = await approvedPlan();
  ok(await campaigns.setDraftingMode(W, c.id, "per_person"));
  for (const key of ["first", "second"]) ok(await campaigns.setupStep(W, c.id, key, { type: "email", touchClass: "cold", mailboxCredentialId: mailbox, audience: "everyone" }));
  ok(await addPeople(c.id, 1));
  await nextSteps.offerFollowUp(W, c.id, "second");
  const offered = (await card(c.id, "due_to_drafts"))!;
  ok(await campaigns.setStepDraftingMode(W, c.id, "second", "template"));
  expect((await approve(offered.id, "Europe/London")).status).toBe(409);
});

test("one waiting-on Item per Campaign names its owner and what People wait on, and goes away when nothing does", async () => {
  const c = await approvedPlan();
  const waiting = async () => (await items.list(W, { needsYou: true, offset: 0, limit: 500 })).items.filter((i) => i.groupKey === `campaign_waiting:${c.id}`).map((i) => i.title);
  ok(await campaigns.setDraftingMode(W, c.id, "template"));
  ok(await campaigns.setupStep(W, c.id, "first", { type: "email", touchClass: "cold", mailboxCredentialId: null, audience: "everyone" }));
  ok(await addPeople(c.id, 3));
  expect(await waiting()).toEqual([expect.stringMatching(/'s Campaign: 3 People waiting on a Mailbox for the step$/)]);
  // Due a working day before the first step it holds up: "first" goes Tue 3 Nov.
  const [held] = (await items.list(W, { needsYou: true, offset: 0, limit: 500 })).items.filter((i) => i.groupKey === `campaign_waiting:${c.id}`);
  expect((await items.view(W, held!.id))!.decideBy).toEqual(new Date("2026-11-02T09:00:00Z"));
  ok(await campaigns.setupStep(W, c.id, "first", { type: "email", touchClass: "cold", mailboxCredentialId: mailbox, audience: "everyone" }));
  expect(await waiting()).toEqual([expect.stringMatching(/'s Campaign: 3 People waiting on the step's text$/)]);
  ok(await campaigns.saveTemplate(W, c.id, "first", { revision: 0, ...TEMPLATE, userId: owner }));
  expect(await waiting()).toEqual([]);
});

test("a moved launch moves when a follow-up is due", async () => {
  const c = await approvedPlan();
  ok(await campaigns.setDraftingMode(W, c.id, "per_person"));
  for (const key of ["first", "second"]) ok(await campaigns.setupStep(W, c.id, key, { type: "email", touchClass: "cold", mailboxCredentialId: mailbox, audience: "everyone" }));
  await db.query("begin");
  await db.query("select set_config('app.workspace_id', $1, true)", [W]);
  // The plan starts 2 Nov; launching on 5 Nov moves "second" from 10 Nov to 13 Nov, due from 11 Nov.
  await db.query("update campaigns set anchor_on = '2026-11-05' where id = $1", [c.id]);
  await db.query("commit");
  const before = clock.at;
  try {
    clock.at = new Date("2026-11-10T09:00:00Z");
    expect((await campaigns.followUpsDue()).filter((d) => d.campaignId === c.id)).toEqual([]);
    clock.at = new Date("2026-11-11T09:00:00Z");
    expect((await campaigns.followUpsDue()).filter((d) => d.campaignId === c.id)).toEqual([{ workspaceId: W, campaignId: c.id, stepKey: "second" }]);
  } finally {
    clock.at = before;
  }
});

test("moving the launch later moves unsent drafts and keeps approvals; earlier asks again; one notice says so", async () => {
  // The plan starts Mon 2 Nov with its first email on Tue 3 Nov.
  const c = await approvedPlan();
  await setUp(c.id);
  ok(await addPeople(c.id, 2));
  ok(await campaigns.saveTemplate(W, c.id, "first", { revision: 0, ...TEMPLATE, userId: owner }));
  const [a, b] = ok(await campaigns.makeDrafts(W, c.id, "first", { timeZone: "UTC", userId: owner })).results.map((r) => r.itemId!);
  expect((await approve(a!)).status).toBe(200);
  const view = async (itemId: string) => (await items.view(W, itemId))!;
  const day = async (itemId: string) => (await view(itemId)).at!.toISOString().slice(0, 10);
  const notices = async () => (await items.list(W, { needsYou: true, offset: 0, limit: 500 })).items.filter((i) => i.groupKey === `campaign_launch_moved:${c.id}`).map((i) => i.title);

  // Each draft is due a working day before it goes: b goes on Tue 3 Nov, so Mon 2 Nov at the same time.
  const dayBefore = async (itemId: string) => new Date((await view(itemId)).at!.getTime() - 86_400_000);
  expect((await view(b!)).decideBy).toEqual(await dayBefore(b!));
  expect(ok(await campaigns.moveAnchor(W, c.id, { on: "2026-11-05" }, actor, { preview: true }))).toMatchObject({ moved: 2, kept: 1, backToApproval: 0 });
  expect(await day(a!)).toBe("2026-11-03");

  expect(ok(await campaigns.moveAnchor(W, c.id, { on: "2026-11-05" }, actor))).toMatchObject({ from: "2026-11-02", to: "2026-11-05", moved: 2, kept: 1, backToApproval: 0, failed: 0 });
  expect(await view(a!)).toMatchObject({ state: "scheduled" });
  expect([await day(a!), await day(b!)]).toEqual(["2026-11-06", "2026-11-06"]);
  expect((await view(b!)).decideBy).toEqual(await dayBefore(b!));
  expect((await campaigns.campaign(W, c.id))!.steps[0]).toMatchObject({ on: "2026-11-06" });
  // It names who approved, so they know the time they approved has moved.
  expect(await notices()).toEqual([expect.stringMatching(/^Launch moved Mon 2 Nov to Thu 5 Nov: 1 approved Item goes later as approved \(approved by [^@\s]+@[^)\s]+\)$/)]);

  expect(ok(await campaigns.moveAnchor(W, c.id, { on: "2026-11-03" }, actor))).toMatchObject({ moved: 2, kept: 0, backToApproval: 1 });
  expect(await view(a!)).toMatchObject({ state: "needs_approval" });
  expect(await notices()).toEqual(["Launch moved Thu 5 Nov to Tue 3 Nov: 1 needs approving again"]);

  expect(await campaigns.moveAnchor(W, c.id, { on: "2026-11-03" }, actor)).toEqual({ ok: false, reason: "same_anchor" });
  expect(await campaigns.moveAnchor(W, c.id, { on: "2026-10-01" }, actor)).toEqual({ ok: false, reason: "date_in_past" });
  expect(await campaigns.moveAnchor(W, crypto.randomUUID(), { on: "2026-11-09" }, actor)).toEqual({ ok: false, reason: "not_found" });
});

async function waitingOnSecond() {
  const c = await approvedPlan();
  ok(await campaigns.setDraftingMode(W, c.id, "template"));
  ok(await campaigns.setupStep(W, c.id, "first", { type: "email", touchClass: "cold", mailboxCredentialId: mailbox, audience: "everyone", dependsOnStepKey: "second" }));
  return c;
}
const stalls = async (campaignId: string) => (await items.list(W, { needsYou: true, offset: 0, limit: 500 })).items.filter((i) => i.groupKey === `campaign_stall:${campaignId}:second`);
async function on<T>(iso: string, f: () => Promise<T>): Promise<T> {
  const before = clock.at;
  clock.at = new Date(iso);
  try {
    return await f();
  } finally {
    clock.at = before;
  }
}

test("a step others wait on is asked about 3 days after its date; keep waiting asks again 3 days later; going ahead unblocks them", async () => {
  // "second" is on Tue 10 Nov and has no URL; "first" waits on it.
  const c = await waitingOnSecond();
  await on("2026-11-12T09:00:00Z", () => campaigns.offerStalls());
  expect(await stalls(c.id)).toEqual([]);
  await on("2026-11-13T09:00:00Z", () => campaigns.offerStalls());
  const [asked] = await stalls(c.id);
  expect(asked!.title).toBe(`"Second" has no URL 3 days after its date: keep waiting, go ahead without it, or cancel`);

  // Approving the question keeps waiting, from that day.
  await on("2026-11-13T10:00:00Z", async () => expect((await approve(asked!.id)).status).toBe(200));
  await on("2026-11-15T09:00:00Z", () => campaigns.offerStalls());
  expect(await stalls(c.id)).toEqual([]);
  await on("2026-11-16T09:00:00Z", () => campaigns.offerStalls());
  expect(await stalls(c.id)).toHaveLength(1);

  expect(ok(await campaigns.resolveStall(W, c.id, "second", "go_ahead", actor))).toEqual({ ok: true, cancelled: [], waived: ["first"], itemsCancelled: 0 });
  expect(await stalls(c.id)).toEqual([]);
  ok(await addPeople(c.id, 1));
  ok(await campaigns.saveTemplate(W, c.id, "first", { revision: 0, ...TEMPLATE, userId: owner }));
  expect(ok(await campaigns.makeDrafts(W, c.id, "first", { timeZone: "UTC", userId: owner })).results.filter((r) => r.ok)).toHaveLength(1);
});

test("when a step's text links to the missing output, the only answers are wait or cancel, and cancel ends both steps", async () => {
  const c = await waitingOnSecond();
  ok(await campaigns.saveTemplate(W, c.id, "first", { revision: 0, subject: "It's live", text: "Hello {{firstName}}, see {{steps.second.url}}", userId: owner }));
  await on("2026-11-13T09:00:00Z", () => campaigns.offerStalls());
  expect((await stalls(c.id))[0]!.title).toBe(`"Second" has no URL 3 days after its date: keep waiting or cancel; a step's text links to it`);
  expect((await approve((await stalls(c.id))[0]!.id, "cancel")).status).toBe(409);
  expect(await campaigns.resolveStall(W, c.id, "second", "go_ahead", actor)).toEqual({ ok: false, reason: "go_ahead_not_possible" });
  expect(ok(await campaigns.resolveStall(W, c.id, "second", "cancel", actor))).toMatchObject({ cancelled: ["second", "first"], waived: [] });
  expect(await campaigns.makeDrafts(W, c.id, "first", { timeZone: "UTC", userId: owner })).toEqual({ ok: false, reason: "step_cancelled" });
  expect(await stalls(c.id)).toEqual([]);
});

test("a launch that follows a step moves everything when that step's URL comes late, and nothing when it comes early", async () => {
  const c = await approvedPlan();
  await setUp(c.id);
  expect(await campaigns.followStep(W, c.id, "first", actor)).toEqual({ ok: false, reason: "not_output_step" });
  ok(await campaigns.followStep(W, c.id, "second", actor));
  expect((await campaigns.campaign(W, c.id))!.anchor).toEqual({ on: "2026-11-02", stepKey: "second" });
  ok(await addPeople(c.id, 1));
  ok(await campaigns.saveTemplate(W, c.id, "first", { revision: 0, ...TEMPLATE, userId: owner }));
  const [draft] = ok(await campaigns.makeDrafts(W, c.id, "first", { timeZone: "UTC", userId: owner })).results.map((r) => r.itemId!);

  // The page goes live on Wed 4 Nov, two days after the planned launch: the email goes two days later.
  await on("2026-11-04T08:00:00Z", async () => ok(await campaigns.recordOutput(W, c.id, "second", "https://acme.test/launch", actor)));
  expect((await campaigns.campaign(W, c.id))!.anchor.on).toBe("2026-11-04");
  expect((await items.view(W, draft!))!.at!.toISOString().slice(0, 10)).toBe("2026-11-05");

  const early = await approvedPlan();
  await setUp(early.id);
  ok(await campaigns.moveAnchor(W, early.id, { on: "2026-11-09" }, actor));
  ok(await campaigns.followStep(W, early.id, "second", actor));
  ok(await campaigns.recordOutput(W, early.id, "second", "https://acme.test/early", actor));
  expect((await campaigns.campaign(W, early.id))!.anchor.on).toBe("2026-11-09");
});

test("cancelling the step the launch follows keeps the launch on its date and says so", async () => {
  const c = await waitingOnSecond();
  ok(await campaigns.followStep(W, c.id, "second", actor));
  ok(await campaigns.resolveStall(W, c.id, "second", "cancel", actor));
  expect((await campaigns.campaign(W, c.id))!.anchor).toEqual({ on: "2026-11-02", stepKey: null });
  const notices = (await items.list(W, { needsYou: true, offset: 0, limit: 500 })).items.filter((i) => i.groupKey === `campaign_launch_moved:${c.id}`).map((i) => i.title);
  expect(notices).toEqual([`Launch no longer follows "Second"; it stays on Mon 2 Nov`]);
  expect((await campaigns.campaign(W, c.id))!.steps.find((s) => s.key === "second")).toMatchObject({ cancelled: true });
});

test("a card asked for in Ask is the chain's own card; a named area that isn't the card's makes none; work that can't start makes none", async () => {
  const c = await approvedPlan();
  await setUp(c.id);
  const before = (await card(c.id, "plan_to_templates"))!;
  expect(await nextSteps.offerAsked(W, { link: "plan_to_templates", campaignId: c.id, onlyArea: "social" })).toEqual({ otherArea: "outreach" });
  expect((await card(c.id, "plan_to_templates"))!.id).toBe(before.id);
  const asked = await nextSteps.offerAsked(W, { link: "plan_to_templates", campaignId: c.id, onlyArea: "outreach" });
  expect(asked).toEqual({ itemId: (await card(c.id, "plan_to_templates"))!.id });
  // No template yet, no step key, or a Campaign that isn't there: nothing to start, and why.
  expect(await nextSteps.offerAsked(W, { link: "template_to_drafts", campaignId: c.id, stepKey: "first" })).toEqual({ why: "no_text_yet" });
  expect(await nextSteps.offerAsked(W, { link: "due_to_drafts", campaignId: c.id })).toEqual({ why: "no_step" });
  expect(await nextSteps.offerAsked(W, { link: "plan_to_templates", campaignId: crypto.randomUUID() })).toEqual({ why: "not_found" });
  expect(started.filter((s) => s.campaignId === c.id)).toEqual([]);
});
