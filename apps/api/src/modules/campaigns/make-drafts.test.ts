// SPDX-License-Identifier: AGPL-3.0-only
// From an approved plan to a sent message: real plans, Items, ledger and floors, through the real Gmail
// plugin to a fake Gmail. A template is saved by hand here; the run that writes one has its own test.
import { createGmailPlugin } from "@direx/extensions";
import { startFakeGmail } from "@direx/extensions/gmail/fake";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, describe, expect, test } from "vitest";
import { appClient, ownerClient } from "../../../../../test/db";
import { createVault, credentialLabel, credentialReady, rootKeyFromEnv } from "../credentials/index";
import { reserveTouch } from "../schedule/index";
import { createFacts, factKinds, describeFactChange, factVersion } from "../facts/index";
import { approverMayApprove, workspaceLive } from "../identity/index";
import { createItems, itemRoutes } from "../items/index";
import { TEST_SECRET, testIdentity, testLedger } from "../outreach/fixtures/support";
import { createOutreach, createOutsideTouches, humanReply, outreachFloors } from "../outreach/index";
import { createPlans, planKinds, type PlanBody } from "../plans/index";
import { loadPlugins } from "../plugins/index";
import { touchCheck } from "../schedule/index";
import { inWorkspace } from "./adapters/repo";
import { campaignCheck, campaignKinds, campaignOnPlanApproved, campaignOnPlanCreated, campaignOutsideReplies, campaignReplies, createCampaigns, stepOutputVersion, templateVersion } from "./index";
import { passMailboxCheck } from "../outreach/fixtures/support";

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
const items = createItems({ ledger, now, kinds: { ...factKinds(), ...planKinds({ now, onPlanApproved: campaignOnPlanApproved({ now, items: () => items }) }), ...campaignKinds({ now }) }, describeChange: describeFactChange });
/** Runs while an email is being prepared: after Make drafts decided who goes, before anything is written. */
let beforePrepare: (() => Promise<unknown>) | undefined;
const outreach = createOutreach({
  items: () => items,
  send: () => ({
    id: SEND,
    dedupe: "queryable",
    prepare: async (ws, input) => {
      await beforePrepare?.();
      return plugins.prepare(ws, SEND, input);
    },
  }),
  baseUrl: () => "https://direx.example",
  ledger: () => ledger,
  now,
});
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const touches = createOutsideTouches({ replies: () => campaignOutsideReplies({ items: () => items }), now });
const hooked: unknown[] = [];
const campaigns = createCampaigns({
  plans,
  facts,
  items: () => items,
  outreach: () => outreach,
  outsideTouches: () => touches,
  startDraft: () => async () => ({ ok: false, reason: "not_here" }),
  now,
  onTemplateSaved: async (workspaceId, s) => void hooked.push({ saved: { workspaceId, ...s } }),
  onSetupChanged: async (workspaceId, s) => void hooked.push({ setup: { workspaceId, ...s } }),
});

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
const newCredential = async (key: string, connection: string | null) => {
  const c = await vault.create({ workspaceId: W, actorUserId: owner, scope: "workspace", kind: "api_key", key, name: key, meta: {}, value: { key: "x" } });
  if (!c.ok) throw new Error(c.reason);
  if (connection) await q("update credentials set kind = 'oauth2', scope = 'user', owner_user_id = $1, connection = $2 where id = $3", [owner, connection, c.credential.id]);
  await passMailboxCheck(W, c.credential.id);
  return c.credential.id;
};
const mailbox = await newCredential("me@acme.test", "google");
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
const body: PlanBody = {
  schemaVersion: 1,
  goal: "4 meetings",
  audience: "Ops",
  startsOn: "2026-11-02",
  endsOn: "2026-11-30",
  steps: [
    { key: "first", on: ON, title: "First" },
    { key: "second", on: "2026-11-10", title: "Second" },
  ],
  measures: [{ key: "m", label: "Meetings", target: "4", basis: { kind: "assumption" } }],
  budget: [],
  assumptions: [],
};
async function ready(box: string = mailbox) {
  const plan = await plans.createPlan(W, { title: "Q4", createdBy: owner });
  const { revision } = ok(await plans.savePlanDraft(W, plan.id, { revision: 0, body }));
  expect((await approve(ok(await plans.submitPlan(W, plan.id, { revision, actor })).item)).status).toBe(200);
  const id = (await campaigns.list(W)).find((c) => c.planId === plan.id)!.id;
  ok(await campaigns.setDraftingMode(W, id, "template"));
  ok(await campaigns.setupStep(W, id, "first", { type: "email", touchClass: "cold", mailboxCredentialId: box, audience: "everyone" }));
  return id;
}
const TEMPLATE = { subject: "Hi {{firstName}}", text: "Hello {{firstName}} at {{company}}, from {{senderName}}." };
const write = async (id: string, t = TEMPLATE, revision = 0) => ok(await campaigns.saveTemplate(W, id, "first", { revision, ...t, userId: owner }));
const address = () => `${crypto.randomUUID()}@acme.test`;
const ELIGIBLE = "US,published_address,Their contact page";
const addPeople = async (id: string, rows: string[]) =>
  ok(await campaigns.addPeople(W, id, { csv: `email,first_name,company,country,basis,evidence\n${rows.join("\n")}`, userId: owner })).results.map((r) => {
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.personId;
  });
const person = (over: { email?: string; first?: string; company?: string } = {}) => `${over.email ?? address()},${over.first ?? "Kim"},${over.company ?? "Acme"},${ELIGIBLE}`;
const make = (id: string) => campaigns.makeDrafts(W, id, "first", { timeZone: "UTC", userId: owner });
const made = async (id: string) => ok(await make(id)).results;
const actionOf = async (itemId: string) => (await q("select action_id from items where id = $1", [itemId]))[0].action_id as string;
const message = (i: number) => Buffer.from(Buffer.from(fake.sent[i]!.raw, "base64url").toString().split("\r\n\r\n")[1]!, "base64").toString();

test("refusals before any draft: no template, no Mailbox, no campaign", async () => {
  const id = await ready();
  expect(await make(id)).toEqual({ ok: false, reason: "no_template" });
  const noBox = await ready();
  ok(await campaigns.setupStep(W, noBox, "first", { type: "email", touchClass: "cold", mailboxCredentialId: null, audience: "everyone" }));
  await write(noBox);
  expect(await make(noBox)).toEqual({ ok: false, reason: "mailbox_required" });
  expect(await campaigns.makeDrafts(W, crypto.randomUUID(), "first", { timeZone: "UTC", userId: owner })).toEqual({ ok: false, reason: "not_found" });
});

test("an email whose Campaign link can't be written leaves nothing behind: no Action and no unsubscribe token", async () => {
  const id = await ready();
  await write(id);
  const to = address();
  const [personId] = await addPeople(id, [person({ email: to })]);
  // The Person's Campaign row goes while their email is prepared, so the link has nothing to point at.
  // The app may never delete that row, so the owner does, as a stand-in for any failure at link time.
  beforePrepare = async () => {
    const owner = await ownerClient();
    await owner.query("delete from campaign_people where campaign_id = $1 and person_id = $2", [id, personId]).finally(() => owner.end());
  };
  try {
    await expect(make(id)).rejects.toThrow(/insert into "campaign_actions"/);
  } finally {
    beforePrepare = undefined;
  }
  expect(await q("select count(*)::int as n from actions where idempotency_key = $1", [`campaign:${id}:step:first:person:${personId}`])).toEqual([{ n: 0 }]);
  expect(await q("select count(*)::int as n from unsubscribe_tokens where email = $1", [to])).toEqual([{ n: 0 }]);
});

test("a Person removed while their email is prepared gets none, and the others still get theirs", async () => {
  const id = await ready();
  await write(id);
  const [gone, stays] = await addPeople(id, [person({ first: "Kim" }), person({ first: "Lee" })]);
  beforePrepare = async () => {
    beforePrepare = undefined;
    ok(await campaigns.removePerson(W, id, gone!, owner));
  };
  const results = await made(id);
  expect(results.find((r) => r.personId === gone)).toMatchObject({ ok: false, reason: "person_removed" });
  expect(results.find((r) => r.personId === stays)).toMatchObject({ ok: true });
  expect(await q("select count(*)::int as n from actions where idempotency_key = $1", [`campaign:${id}:step:first:person:${gone}`])).toEqual([{ n: 0 }]);
  // Frees the Mailbox's slot for the tests after this one.
  ok(await campaigns.removePerson(W, id, stays!, owner));
});

test("a credential that isn't a connected mail account can't be a step's Mailbox", async () => {
  const key = await newCredential(`model-${crypto.randomUUID()}`, null);
  const id = await ready();
  expect(await campaigns.setupStep(W, id, "first", { type: "email", touchClass: "cold", mailboxCredentialId: key, audience: "everyone" })).toEqual({ ok: false, reason: "not_a_mailbox" });
});

test("one Action Item per eligible Person, merged, grouped and waiting for approval; twice makes no more", async () => {
  const id = await ready();
  await write(id);
  const [a] = await addPeople(id, [person({ first: "Kim" }), person({ first: "Lee" })]);
  const first = await made(id);
  expect(first).toHaveLength(2);
  expect(first.every((r) => r.ok && r.already === false)).toBe(true);
  const view = await items.view(W, first.find((r) => r.personId === a)!.itemId!);
  expect(view).toMatchObject({ title: "Hi Kim", groupKey: `campaign:${id}:step:first`, groupLabel: "Q4" });

  const again = await made(id);
  expect(again.map((r) => r.already)).toEqual([true, true]);
  expect(new Set(again.map((r) => r.itemId))).toEqual(new Set(first.map((r) => r.itemId)));
  expect((await q("select count(*)::int as n from campaign_actions where campaign_id = $1", [id]))[0].n).toBe(2);
});

test("a preview says what making drafts would do, with one real Person's email, and changes nothing", async () => {
  const id = await ready();
  await write(id);
  await addPeople(id, [person({ first: "Dana", company: "Beta" })]);
  ok(await campaigns.addPeople(W, id, { csv: `email,first_name,company\nno-basis-${crypto.randomUUID()}@acme.test,Kim,Beta`, userId: owner }));
  const preview = ok(await campaigns.previewDrafts(W, id, "first"));
  expect(preview).toMatchObject({ willMake: 1, already: 0, sample: { subject: "Hi Dana", text: "Hello Dana at Beta, from Sam at Acme." } });
  expect(preview.leftOut).toMatchObject([{ leftOut: { reason: "not_eligible", fields: ["no basis recorded"] } }]);
  expect((await q("select count(*)::int as n from campaign_actions where campaign_id = $1", [id]))[0].n).toBe(0);

  await made(id);
  expect(ok(await campaigns.previewDrafts(W, id, "first"))).toMatchObject({ willMake: 0, already: 1, sample: null });
});

test("two steps with the same words make two Actions", async () => {
  const id = await ready();
  await write(id);
  ok(await campaigns.setupStep(W, id, "second", { type: "email", touchClass: "cold", mailboxCredentialId: mailbox, audience: "everyone" }));
  ok(await campaigns.saveTemplate(W, id, "second", { revision: 0, ...TEMPLATE, userId: owner }));
  await addPeople(id, [person()]);
  const [one] = await made(id);
  const [two] = ok(await campaigns.makeDrafts(W, id, "second", { timeZone: "UTC", userId: owner })).results;
  expect(two!.itemId).not.toBe(one!.itemId);
});

test("everyone left out says why", async () => {
  const id = await ready();
  await write(id);
  const optedOut = address();
  const [removed] = await addPeople(id, [person(), person({ email: optedOut })]);
  ok(await campaigns.removePerson(W, id, removed!, owner));
  await outreach.addSuppression(W, optedOut);
  ok(await campaigns.addPeople(W, id, { csv: `email,first_name,company\n${address()},Kim,Beta`, userId: owner }));
  ok(await campaigns.addPeople(W, id, { csv: `email,first_name,country,basis,evidence\n${address()},Kim,${ELIGIBLE}`, userId: owner }));
  const out = (await made(id)).map((r) => r.leftOut);
  expect(out).toHaveLength(4);
  expect(out).toEqual(
    expect.arrayContaining([
      { reason: "removed" },
      { reason: "not_eligible", fields: ["opted out"] },
      { reason: "not_eligible", fields: ["no basis recorded"] },
      { reason: "missing_merge_field", fields: ["company"] },
    ]),
  );
});

test("a list row whose basis has expired gets no draft; a new record lets the draft be made, approved and sent", async () => {
  const id = await ready();
  await write(id);
  const to = address();
  const csv = (expires: string) => `email,first_name,company,country,basis,evidence,expires\n${to},Ada,Acme,US,consent,Signed up,${expires}`;
  ok(await campaigns.addPeople(W, id, { csv: csv("2020-01-01"), userId: owner }));
  expect((await made(id)).map((r) => r.leftOut)).toEqual([{ reason: "not_eligible", fields: ["basis expired on 2020-01-01"] }]);

  ok(await campaigns.addPeople(W, id, { csv: csv("2099-01-01"), userId: owner }));
  const [one] = await made(id);
  expect(one).toMatchObject({ itemId: expect.any(String) });
  const action = await actionOf(one!.itemId!);
  expect((await approve({ id: one!.itemId! })).status).toBe(200);
  const [start, before] = [clock.at, fake.sent.length];
  clock.at = new Date(`${ON}T16:00:00Z`);
  await ledger.run(W, action);
  clock.at = start;
  expect(fake.sent).toHaveLength(before + 1);
  expect(await items.view(W, one!.itemId!)).toMatchObject({ state: "sent" });
});

test("a template with a price no Fact holds makes no drafts, and can't be saved over existing ones", async () => {
  ok(await facts.set(W, { field: "price", subject: "audit", value: "$4,500", source: { kind: "person", label: "Sam" }, confidence: "high", actor }));
  const id = await ready();
  await write(id, { subject: "Audit", text: "It costs $3,900." });
  await addPeople(id, [person()]);
  expect(await make(id)).toEqual({ ok: false, reason: "needs_decision" });

  const withDrafts = await ready();
  await write(withDrafts);
  await addPeople(withDrafts, [person()]);
  await made(withDrafts);
  expect(await campaigns.saveTemplate(W, withDrafts, "first", { revision: 1, subject: "Audit", text: "It costs $3,900.", userId: owner })).toEqual({ ok: false, reason: "needs_decision" });
});

test("a stale revision and a field that doesn't exist are refused", async () => {
  const id = await ready();
  await write(id);
  expect(await campaigns.saveTemplate(W, id, "first", { revision: 0, subject: "x", text: "y", userId: owner })).toEqual({ ok: false, reason: "target_changed" });
  expect(await campaigns.saveTemplate(W, id, "first", { revision: 1, subject: "x", text: "{{title}}", userId: owner })).toEqual({ ok: false, reason: "unknown_merge_field" });
});

test("times start at 09:00 on the step's day and take up where a Mailbox's other emails left off", async () => {
  const box = await newCredential(`times-${crypto.randomUUID()}@acme.test`, "google");
  const id = await ready(box);
  await write(id);
  await addPeople(id, [person(), person()]);
  const plannedOf = async (itemId: string) => new Date((await items.view(W, itemId))!.at!).toISOString();
  const times = await Promise.all((await made(id)).map((r) => plannedOf(r.itemId!)));
  expect(times.sort()).toEqual([`${ON}T09:00:00.000Z`, `${ON}T09:09:36.000Z`]);

  const other = await ready(box);
  await write(other);
  await addPeople(other, [person()]);
  const [next] = await made(other);
  expect(await plannedOf(next!.itemId!)).toBe(`${ON}T09:19:12.000Z`);
});

test("removing someone cancels what hasn't gone", async () => {
  const id = await ready();
  await write(id);
  const [personId] = await addPeople(id, [person()]);
  const [one] = await made(id);
  ok(await campaigns.removePerson(W, id, personId!, owner));
  expect((await items.view(W, one!.itemId!))).toMatchObject({ state: "cancelled" });
});

test("the Campaign's activity says what was drafted and cancelled, and a notice of its own", async () => {
  const id = await ready();
  await write(id);
  const [personId] = await addPeople(id, [person({ first: "Kim" }), person({ first: "Lee" })]);
  await made(id);
  ok(await campaigns.removePerson(W, id, personId!, owner));
  ok(await items.createItem(W, { kind: "fact_proposal", payload: {}, actor, details: { title: "The launch moved", workArea: "outreach", channel: null, warnings: [], plannedAt: null, groupKey: `campaign_launch_moved:${id}` } }));
  // Another Campaign's notice whose id starts the same isn't this one's.
  ok(await items.createItem(W, { kind: "fact_proposal", payload: {}, actor, details: { title: "Not ours", workArea: "outreach", channel: null, warnings: [], plannedAt: null, groupKey: `campaign_launch_moved:${id}0` } }));
  const lines = (await campaigns.activity(W, id))!.map((l) => l.text);
  // This file's clock stands still, so the order is the pure function's to prove (activity.test.ts).
  expect(lines.sort()).toEqual(["Cancelled 1 email of First", "Created the campaign from its plan", "Drafted First for 2 people", "The launch moved"]);
  expect(await campaigns.activity(W, "00000000-0000-4000-8000-000000000999")).toBeUndefined();
});

test("plan approved to a sent message, with the footer; an edit voids the approval first and keeps the Action", async () => {
  const id = await ready();
  await write(id);
  await addPeople(id, [person({ first: "Dana", company: "Beta" })]);
  const [one] = await made(id);
  const itemId = one!.itemId!;
  const action = await actionOf(itemId);
  expect((await approve({ id: itemId })).status).toBe(200);

  expect(await write(id, { subject: "Hi {{firstName}}", text: "New words for {{company}}." }, 1)).toMatchObject({ revised: 1, failed: [] });
  expect(await actionOf(itemId)).toBe(action);

  const start = clock.at;
  const before = fake.sent.length;
  clock.at = new Date(`${ON}T16:00:00Z`);
  await ledger.run(W, action);
  expect(fake.sent).toHaveLength(before);

  clock.at = start;
  expect((await approve({ id: itemId })).status).toBe(200);
  clock.at = new Date(`${ON}T16:00:00Z`);
  await ledger.run(W, action);
  expect(fake.sent).toHaveLength(before + 1);
  const text = message(before);
  expect(text).toContain("New words for Beta.");
  expect(text).toContain("Sam at Acme\n1 Main St");
  expect(text).toContain("Unsubscribe: https://direx.example/api/unsubscribe/");
  expect(await items.view(W, itemId)).toMatchObject({ state: "sent" });

  clock.at = start;
  const late = await campaigns.saveTemplate(W, id, "first", { revision: 2, subject: "Too", text: "Late.", userId: owner });
  expect(ok(late).failed).toHaveLength(1);
  expect(await items.view(W, itemId)).toMatchObject({ state: "sent" });
});

// What an approval binds: the facts an email cites and the template it came from, and nothing else.
const source = { kind: "person", label: "Sam" } as const;
const newFact = async (subject: string) => ok(await facts.set(W, { field: "price", subject, value: "$100", source, confidence: "high", actor }));
async function approvedCiting(factId: string) {
  const id = await ready();
  await write(id);
  await q("update campaign_steps set template = jsonb_set(template, '{citations}', $1::jsonb) where campaign_id = $2 and step_key = 'first'", [JSON.stringify([{ factId, version: 1 }]), id]);
  await addPeople(id, [person()]);
  const [one] = await made(id);
  const itemId = one!.itemId!;
  expect((await approve({ id: itemId })).status).toBe(200);
  return { id, itemId, action: await actionOf(itemId) };
}
async function sendsAtSlot(action: string) {
  const start = clock.at;
  const before = fake.sent.length;
  clock.at = (await q("select due_at from actions where id = $1", [action]))[0].due_at as Date;
  await ledger.run(W, action);
  clock.at = start;
  return fake.sent.length - before;
}
async function holdOf(action: string) {
  const row = (await q("select state, hold_reason from actions where id = $1", [action]))[0];
  return { ...row, hold_detail: (await ledger.getEvents(W, action)).at(-1)?.detail };
}

test("a corrected cited fact holds an email a person approved, and sends nothing", async () => {
  const fact = await newFact(`corrected-${crypto.randomUUID()}`);
  const { action, itemId } = await approvedCiting(fact.id);
  const subject = (await q("select subject from facts where id = $1", [fact.id]))[0].subject as string;
  ok(await facts.set(W, { field: "price", subject, value: "$120", source, confidence: "high", actor }));
  expect(await sendsAtSlot(action)).toBe(0);
  expect(await holdOf(action)).toMatchObject({ state: "held", hold_reason: "snapshot_changed", hold_detail: `fact:${fact.id}` });
  expect(await items.view(W, itemId)).toMatchObject({ state: "held" });
});

test("a retired cited fact holds it too", async () => {
  const fact = await newFact(`retired-${crypto.randomUUID()}`);
  const { action } = await approvedCiting(fact.id);
  ok(await facts.retire(W, fact.id, actor));
  expect(await sendsAtSlot(action)).toBe(0);
  expect(await holdOf(action)).toMatchObject({ hold_reason: "snapshot_changed" });
});

test("resuming a changed fact asks again, says what it is now, and a person's approval sends it", async () => {
  const fact = await newFact(`resumed-${crypto.randomUUID()}`);
  const { action, itemId } = await approvedCiting(fact.id);
  const subject = (await q("select subject from facts where id = $1", [fact.id]))[0].subject as string;
  ok(await facts.set(W, { field: "price", subject, value: "$120", source, confidence: "high", actor }));
  expect(await sendsAtSlot(action)).toBe(0);

  const resumed = await items.resume(W, itemId, actor);
  expect(resumed.ok && resumed.item).toMatchObject({ state: "needs_approval", clean: false });
  expect(resumed.ok && resumed.item.warnings.map((w) => w.text).join()).toContain('is now "$120"');
  expect((await q("select count(*)::int as n from approvals where action_id = $1 and voided_at is null", [action]))[0].n).toBe(0);

  expect((await approve({ id: itemId })).status).toBe(200);
  expect(await sendsAtSlot(action)).toBe(1);
});

test("resuming a retired fact asks again too, and the new approval no longer binds it", async () => {
  const fact = await newFact(`retired-resume-${crypto.randomUUID()}`);
  const { action, itemId } = await approvedCiting(fact.id);
  ok(await facts.retire(W, fact.id, actor));
  expect(await sendsAtSlot(action)).toBe(0);
  const resumed = await items.resume(W, itemId, actor);
  expect(resumed.ok && resumed.item.warnings.map((w) => w.text).join()).toContain("retired");
  expect((await approve({ id: itemId })).status).toBe(200);
  expect(await sendsAtSlot(action)).toBe(1);
});

// A rule's approval, written directly: granting and matching have their own tests.
async function ruleApproved(factId: string) {
  const id = await ready();
  await write(id);
  await q("update campaign_steps set template = jsonb_set(template, '{citations}', $1::jsonb) where campaign_id = $2 and step_key = 'first'", [JSON.stringify([{ factId, version: 1 }]), id]);
  await addPeople(id, [person()]);
  const itemId = (await made(id))[0]!.itemId!;
  const action = await actionOf(itemId);
  const [rule] = await q(
    `insert into standing_rules (workspace_id, capability, touch_class, campaign_id, step_key, template_revision, facts, capability_hash, daily_cap, expires_at, granted_by, granted_at, people_as_of)
     values ($1, $2, 'cold', $3, 'first', 1, '[]', 'h', 50, $4, $5, $4, $4) returning id`,
    [W, SEND, id, clock.at, owner],
  );
  const [row] = await q("select snapshot, planned_at from items where id = $1", [itemId]);
  const slot = (row.planned_at ?? clock.at) as Date;
  expect((await reserveTouch(W, action, slot, { now: clock.at })).kind).not.toBe("full");
  return { action, itemId, ruleId: rule.id as string, snapshot: row.snapshot, slot };
}

test("a rule's approval signs in the granter's name with a system actor, and sends", async () => {
  const fact = await newFact(`rule-send-${crypto.randomUUID()}`);
  const r = await ruleApproved(fact.id);
  ok(await ledger.approveByRule(W, r.action, { ruleId: r.ruleId, draftVersion: 1, snapshot: r.snapshot, dueAt: r.slot }));
  expect((await q("select approver_id, standing_rule_id from approvals where action_id = $1", [r.action]))[0]).toEqual({ approver_id: owner, standing_rule_id: r.ruleId });
  expect((await ledger.getEvents(W, r.action)).at(-1)).toMatchObject({ actorSystem: "standing_rule", actorUserId: null });
  expect(await sendsAtSlot(r.action)).toBe(1);
});

test("a revoked rule can't approve", async () => {
  const fact = await newFact(`rule-revoked-${crypto.randomUUID()}`);
  const r = await ruleApproved(fact.id);
  await q("update standing_rules set status = 'revoked' where id = $1", [r.ruleId]);
  expect(await ledger.approveByRule(W, r.action, { ruleId: r.ruleId, draftVersion: 1, snapshot: r.snapshot })).toEqual({ ok: false, reason: "rule_not_active" });
});

test("a changed fact holds a rule's approval for review, and resuming returns it to a person", async () => {
  const fact = await newFact(`rule-held-${crypto.randomUUID()}`);
  const r = await ruleApproved(fact.id);
  ok(await ledger.approveByRule(W, r.action, { ruleId: r.ruleId, draftVersion: 1, snapshot: r.snapshot, dueAt: r.slot }));
  const subject = (await q("select subject from facts where id = $1", [fact.id]))[0].subject as string;
  ok(await facts.set(W, { field: "price", subject, value: "$120", source, confidence: "high", actor }));
  expect(await sendsAtSlot(r.action)).toBe(0);
  expect(await holdOf(r.action)).toMatchObject({ hold_reason: "rule_needs_review", hold_detail: "fact changed" });
  const resumed = await items.resume(W, r.itemId, actor);
  expect(resumed.ok && resumed.item).toMatchObject({ state: "needs_approval", clean: false });
  expect((await approve({ id: r.itemId })).status).toBe(200);
  expect(await sendsAtSlot(r.action)).toBe(1);
});

test("a fact the email doesn't cite changes nothing: it sends", async () => {
  const cited = await newFact(`cited-${crypto.randomUUID()}`);
  const other = `other-${crypto.randomUUID()}`;
  await newFact(other);
  const { action } = await approvedCiting(cited.id);
  ok(await facts.set(W, { field: "price", subject: other, value: "$120", source, confidence: "high", actor }));
  expect(await sendsAtSlot(action)).toBe(1);
});

test("a template revision that moved without reaching this email holds it", async () => {
  const fact = await newFact(`template-${crypto.randomUUID()}`);
  const { id, action } = await approvedCiting(fact.id);
  await q("update campaign_steps set template_revision = template_revision + 1 where campaign_id = $1 and step_key = 'first'", [id]);
  expect(await sendsAtSlot(action)).toBe(0);
  expect(await holdOf(action)).toMatchObject({ hold_reason: "snapshot_changed", hold_detail: `template:campaign:${id}:step:first` });
});

test("saving the template rebinds each unsent email to the new revision, and it sends once approved", async () => {
  const id = await ready();
  await write(id);
  await addPeople(id, [person()]);
  const itemId = (await made(id))[0]!.itemId!;
  const snapshotOf = async () => (await q("select snapshot from items where id = $1", [itemId]))[0].snapshot as { kind: string; version: string }[];
  expect((await snapshotOf()).find((e) => e.kind === "template")?.version).toBe("1");
  await write(id, { subject: "Hi {{firstName}}", text: "New words." }, 1);
  expect((await snapshotOf()).find((e) => e.kind === "template")?.version).toBe("2");
  expect((await approve({ id: itemId })).status).toBe(200);
  expect(await sendsAtSlot(await actionOf(itemId))).toBe(1);
});

// Coordination: the rest of a campaign, on the same real ledger.
const going = async () => {
  const id = await ready();
  await write(id);
  const [personId] = await addPeople(id, [person()]);
  const [one] = await made(id);
  return { id, personId: personId!, itemId: one!.itemId! };
};
const atSendTime = async <T>(fn: () => Promise<T>) => {
  const start = clock.at;
  clock.at = new Date(`${ON}T16:59:00Z`);
  try {
    return await fn();
  } finally {
    clock.at = start;
  }
};
const inbound = (from: string, over: object = {}) => ({ workspaceId: W, credentialId: mailbox, eventId: crypto.randomUUID(), data: { headers: { from, subject: "Re: Hi", date: "", inReplyTo: "", references: "" }, text: "Sounds good.", ...over } });
const receive = (e: ReturnType<typeof inbound>) => inWorkspace(W, (tx) => campaignReplies({ items: () => items, humanReply })(tx, e));
const peopleOf = async (id: string) => (await campaigns.people(W, id)).people;
const answer = (conflict: { itemId: string; revision: number }, choice?: string) => items.approve(W, conflict.itemId, conflict.revision, { approverId: owner as never, may: () => true } as never, choice);

test("a paused campaign's approved email is held, and resuming lets it pass every check again", async () => {
  const { id, itemId } = await going();
  expect((await approve({ id: itemId })).status).toBe(200);
  ok(await campaigns.pause(W, id, owner));
  expect((await campaigns.campaign(W, id))!.paused).toBe(true);
  const action = await actionOf(itemId);
  const before = fake.sent.length;
  await atSendTime(() => ledger.run(W, action));
  expect(await items.view(W, itemId)).toMatchObject({ state: "held", reasonCode: "campaign_paused" });
  expect(fake.sent).toHaveLength(before);

  ok(await campaigns.resume(W, id, owner));
  expect((await campaigns.campaign(W, id))!.paused).toBe(false);
  await atSendTime(() => ledger.run(W, action));
  expect(await items.view(W, itemId)).toMatchObject({ state: "sent" });
  expect(fake.sent).toHaveLength(before + 1);
});

test("a reply cancels that Person's rest and leaves everyone else alone; a stranger changes nothing", async () => {
  const id = await ready();
  await write(id);
  ok(await campaigns.setupStep(W, id, "second", { type: "email", touchClass: "cold", mailboxCredentialId: mailbox, audience: "everyone" }));
  ok(await campaigns.saveTemplate(W, id, "second", { revision: 0, ...TEMPLATE, userId: owner }));
  const replier = address();
  const other = address();
  const [a, b] = await addPeople(id, [person({ email: replier }), person({ email: other })]);
  const first = await made(id);
  const firstOf = (p: string) => first.find((r) => r.personId === p)!.itemId!;
  for (const r of first) expect((await approve({ id: r.itemId! })).status).toBe(200);
  await atSendTime(async () => {
    await ledger.run(W, await actionOf(firstOf(a!)));
    await ledger.run(W, await actionOf(firstOf(b!)));
  });
  const second = ok(await campaigns.makeDrafts(W, id, "second", { timeZone: "UTC", userId: owner })).results;
  const secondOf = (p: string) => second.find((r) => r.personId === p)!.itemId!;

  await receive(inbound(`someone-else-${crypto.randomUUID()}@acme.test`));
  expect((await peopleOf(id)).every((p) => p.status === "active")).toBe(true);

  await receive(inbound(`Kim <${replier}>`));
  const statuses = new Map((await peopleOf(id)).map((p) => [p.personId, p.status]));
  expect(statuses.get(a!)).toBe("replied");
  expect(statuses.get(b!)).toBe("active");
  expect(await items.view(W, secondOf(a!))).toMatchObject({ state: "cancelled" });
  expect(await items.view(W, secondOf(b!))).not.toMatchObject({ state: "cancelled" });
  expect(await items.view(W, firstOf(a!))).toMatchObject({ state: "sent" });
  expect((await campaigns.campaign(W, id))!).toMatchObject({ replied: 1, sent: 2 });
});

test("a DM step drafts one message per Person with a profile, with no approval, and marking it sent logs one touch", async () => {
  const id = await ready();
  const dmStep = { type: "dm", touchClass: "cold", mailboxCredentialId: null, audience: "everyone" } as const;
  expect(await campaigns.setupStep(W, id, "second", dmStep)).toEqual({ ok: false, reason: "dm_setup" });
  ok(await campaigns.setupStep(W, id, "second", { ...dmStep, dmChannel: "linkedin" }));
  expect(await campaigns.makeDms(W, id, "second")).toEqual({ ok: false, reason: "no_template" });
  expect(await campaigns.saveDmText(W, id, "second", { revision: 0, text: "Hi {{nickname}}" })).toEqual({ ok: false, reason: "unknown_merge_field" });
  ok(await campaigns.saveDmText(W, id, "second", { revision: 0, text: "Hi {{firstName}}, saw {{company}}." }));

  const gone = address();
  const [kim, noProfile, optedOut] = await addPeople(id, [person({ first: "Kim" }), person(), person({ email: gone })]);
  ok(await touches.addProfile(W, kim!, "linkedin", "linkedin.com/in/Kim-Lee"));
  ok(await touches.addProfile(W, optedOut!, "linkedin", "linkedin.com/in/gone"));
  expect(await touches.addProfile(W, noProfile!, "linkedin", "example.com/kim")).toEqual({ ok: false, reason: "bad_profile" });
  await outreach.addSuppression(W, gone);

  const results = ok(await campaigns.makeDms(W, id, "second")).results;
  const of = (p: string) => results.find((r) => r.personId === p);
  expect(of(kim!)).toMatchObject({ ok: true, already: false });
  expect(of(noProfile!)).toMatchObject({ ok: false, reason: "no_profile" });
  expect(of(optedOut!)).toMatchObject({ ok: false, leftOut: { reason: "not_eligible" } });
  expect(ok(await campaigns.makeDms(W, id, "second")).results.find((r) => r.personId === kim)).toMatchObject({ already: true });
  const [dm] = await campaigns.dms(W, id, "second");
  expect(dm).toMatchObject({ personId: kim, channel: "linkedin", profileUrl: "https://www.linkedin.com/in/kim-lee", text: "Hi Kim, saw Acme.", copiedAt: null, sentAt: null });
  // Nothing went to the ledger or the approval queue.
  expect(await q("select count(*)::int n from campaign_actions where campaign_id = $1 and step_key = 'second'", [id])).toEqual([{ n: 0 }]);

  expect(ok(await campaigns.copyDm(W, dm!.id))).toMatchObject({ direxTouchNear: false });
  expect(ok(await campaigns.markDmSent(W, dm!.id, owner)).dm).toMatchObject({ sentAt: expect.any(String) });
  ok(await campaigns.markDmSent(W, dm!.id, owner));
  expect(await q("select channel, direction, source, source_ref from outside_touches where person_id = $1", [kim])).toEqual([{ channel: "linkedin", direction: "outbound", source: "direx_draft", source_ref: dm!.id }]);

  // Someone who opts out after the DM was made can't be copied to.
  const [kimEmail] = await q("select value from person_keys where person_id = $1 and kind = 'email'", [kim]);
  await outreach.addSuppression(W, kimEmail.value);
  expect(await campaigns.copyDm(W, dm!.id)).toMatchObject({ ok: false });
});

test("a reply logged by hand on another channel stops that Person, even before Direx emailed them", async () => {
  const { id, personId, itemId } = await going();
  expect((await approve({ id: itemId })).status).toBe(200);
  // A logged call they made isn't a reply, and changes nothing here.
  expect((await touches.log(W, personId, { channel: "call", direction: "outbound", occurredAt: clock.at }, owner)).ok).toBe(true);
  expect((await peopleOf(id)).find((p) => p.personId === personId)!.status).toBe("active");

  expect((await touches.log(W, personId, { channel: "linkedin", direction: "inbound", occurredAt: clock.at }, owner)).ok).toBe(true);
  expect((await peopleOf(id)).find((p) => p.personId === personId)!.status).toBe("replied");
  expect(await items.view(W, itemId)).toMatchObject({ state: "cancelled" });
  const before = fake.sent.length;
  const action = await actionOf(itemId);
  await atSendTime(() => ledger.run(W, action));
  expect(fake.sent).toHaveLength(before);
});

test("an auto-reply or a bounce isn't a reply, and a Person never emailed isn't marked", async () => {
  const email = address();
  const id = await ready();
  await write(id);
  await addPeople(id, [person({ email })]);
  const [one] = await made(id);
  await receive(inbound(email));
  expect((await peopleOf(id))[0]!.status).toBe("active");
  expect((await approve({ id: one!.itemId! })).status).toBe(200);
  await atSendTime(async () => ledger.run(W, await actionOf(one!.itemId!)));
  await receive(inbound(email, { autoSubmitted: "auto-replied" }));
  await receive(inbound(email, { dsn: { recipients: [{ email, status: "5.1.1" }] } }));
  expect((await peopleOf(id))[0]!.status).toBe("active");
});

test("an approved email to someone who has since replied is blocked at send, even if cancelling missed it", async () => {
  const { id, personId, itemId } = await going();
  expect((await approve({ id: itemId })).status).toBe(200);
  await q("update campaign_people set status = 'replied' where campaign_id = $1 and person_id = $2", [id, personId]);
  const before = fake.sent.length;
  await atSendTime(async () => ledger.run(W, await actionOf(itemId)));
  expect(await items.view(W, itemId)).toMatchObject({ state: "blocked" });
  expect(fake.sent).toHaveLength(before);
});

test("someone in a live campaign gets a conflict and no draft, until a person chooses", async () => {
  const email = address();
  const live = await ready();
  await write(live);
  await addPeople(live, [person({ email })]);

  const skipping = await ready();
  await write(skipping);
  await addPeople(skipping, [person({ email })]);
  const [waiting] = await peopleOf(skipping);
  expect(waiting).toMatchObject({ status: "conflict", conflict: { itemId: expect.any(String) } });
  expect(ok(await campaigns.previewDrafts(W, skipping, "first")).leftOut).toMatchObject([{ leftOut: { reason: "conflict" } }]);

  expect(await answer(waiting!.conflict!)).toMatchObject({ ok: false, reason: "choice_required" });
  expect((await peopleOf(skipping))[0]!.status).toBe("conflict");
  expect(await answer(waiting!.conflict!, "skip")).toMatchObject({ ok: true });
  expect((await peopleOf(skipping))[0]).toMatchObject({ status: "removed", conflict: null });
});

test("adding after the other campaign waits until it has finished with them, then gets a draft", async () => {
  const email = address();
  const first = await ready();
  await write(first);
  await addPeople(first, [person({ email })]);
  const [draft] = await made(first);

  const after = await ready();
  await write(after);
  await addPeople(after, [person({ email })]);
  const [row] = await peopleOf(after);
  expect(await answer(row!.conflict!, "add_after")).toMatchObject({ ok: true });
  expect(ok(await campaigns.previewDrafts(W, after, "first"))).toMatchObject({ willMake: 0, leftOut: [{ leftOut: { reason: "conflict" } }] });

  await items.cancel(W, draft!.itemId!, actor);
  expect(ok(await campaigns.previewDrafts(W, after, "first"))).toMatchObject({ willMake: 1, leftOut: [] });
});

test("adding someone who has finished elsewhere, or adding them again here, raises no conflict", async () => {
  const email = address();
  const first = await ready();
  await write(first);
  await addPeople(first, [person({ email })]);
  const [draft] = await made(first);
  await items.cancel(W, draft!.itemId!, actor);
  const next = await ready();
  await addPeople(next, [person({ email })]);
  expect((await peopleOf(next))[0]!.status).toBe("active");
  await addPeople(next, [person({ email })]);
  expect((await peopleOf(next))[0]!.status).toBe("active");
});

test("when every email of a step has ended it reads done, and the counts say what Direx saw", async () => {
  const { id, itemId } = await going();
  const planId = (await campaigns.campaign(W, id))!.planId;
  const statusOf = async () => (await plans.plan(W, planId))!.tracking!.steps.find((s) => s.key === "first")!.status;
  await campaigns.results(W, id);
  expect(await statusOf()).toBe("open");

  expect((await approve({ id: itemId })).status).toBe(200);
  await atSendTime(async () => ledger.run(W, await actionOf(itemId)));
  expect(await campaigns.results(W, id)).toEqual({ sent: 1 });
  expect(await statusOf()).toBe("done");
  expect((await campaigns.campaign(W, id))!).toMatchObject({ sent: 1, done: 1 });
  await campaigns.results(W, id);
  expect(await statusOf()).toBe("done");
});

test("a campaign's results say what it sent and what came back on its email, and nothing it doesn't record", async () => {
  const { id, personId, itemId } = await going();
  // Nothing sent yet: no email numbers at all, not zeros.
  expect(await campaigns.outcomes(W, id)).toMatchObject({ sent: [], email: null, measures: [{ key: "m", label: "Meetings", target: "4", value: null, observedOn: null }] });

  expect((await approve({ id: itemId })).status).toBe(200);
  const actionId = await actionOf(itemId);
  await atSendTime(async () => ledger.run(W, actionId));
  const signal = (kind: string, status: string, event: string) =>
    q("insert into reply_signals (workspace_id, event_id, sender_email, person_id, action_id, kind, status, received_at) values ($1, $2, 'x@example.com', $3, $4, $5, $6, now())", [W, event, personId, actionId, kind, status]);
  await signal("bounce", "recorded", `b-${id}`);
  await signal("reply", "opted_out", `o-${id}`);
  // A reply that wasn't an opt-out counts as neither.
  await signal("reply", "not_opt_out", `n-${id}`);
  const planId = (await campaigns.campaign(W, id))!.planId;
  ok(await plans.recordReading(W, planId, { measureKey: "m", value: "3", observedOn: "2026-11-05", actor }));

  expect(await campaigns.outcomes(W, id)).toEqual({
    sent: [{ kind: "email", channel: "email", n: 1 }],
    email: { replied: 0, bounced: 1, optedOut: 1 },
    measures: [{ key: "m", label: "Meetings", target: "4", value: "3", observedOn: "2026-11-05" }],
  });
  // The list row carries the same measure and the channels its steps use.
  expect((await campaigns.list(W)).find((x) => x.id === id)).toMatchObject({ measure: { label: "Meetings", target: "4", value: "3" }, channels: ["email"] });
});

describe("a step waiting on another step's URL", () => {
  const LINKED = { subject: "Hi {{firstName}}", text: "See {{steps.second.url}}, {{firstName}}." };
  async function linked(utm = false) {
    const id = await ready();
    ok(await campaigns.setupStep(W, id, "first", { type: "email", touchClass: "cold", mailboxCredentialId: mailbox, audience: "everyone", dependsOnStepKey: "second", utm }));
    await write(id, LINKED);
    return id;
  }
  const rowsMade = async (id: string) => ({
    actions: (await q("select count(*)::int as n from campaign_actions where campaign_id = $1", [id]))[0].n,
    items: (await q("select count(*)::int as n from items")).at(0).n,
    calls: (await q("select count(*)::int as n from model_calls")).at(0).n,
  });

  test("makes nothing, and says what it waits on, until that step has a URL", async () => {
    const id = await linked();
    await addPeople(id, [person({ first: "Kim" })]);
    const before = await rowsMade(id);
    expect(await make(id)).toEqual({ ok: false, reason: "waiting_on_step", waitingOn: "second" });
    expect(await campaigns.previewDrafts(W, id, "first")).toEqual({ ok: false, reason: "waiting_on_step", waitingOn: "second" });
    expect(await rowsMade(id)).toEqual(before);

    ok(await campaigns.recordOutput(W, id, "second", "https://acme.test/launch?ref=mail", actor));
    expect(ok(await campaigns.previewDrafts(W, id, "first")).sample).toMatchObject({ text: "See https://acme.test/launch?ref=mail, Kim." });
    expect((await made(id)).every((r) => r.ok)).toBe(true);
  });

  test("with UTM on, the URL carries the step's tags and keeps its own parameters", async () => {
    const id = await linked(true);
    await addPeople(id, [person({ first: "Kim" })]);
    ok(await campaigns.recordOutput(W, id, "second", "https://acme.test/launch?ref=mail&utm_source=old", actor));
    const text = ok(await campaigns.previewDrafts(W, id, "first")).sample!.text;
    const url = new URL(text.slice("See ".length, text.indexOf(",")));
    expect(Object.fromEntries(url.searchParams)).toEqual({ ref: "mail", utm_source: "direx", utm_medium: "email", utm_campaign: id, utm_content: "first" });
  });

  async function approvedLinked(text = LINKED.text) {
    const id = await ready();
    ok(await campaigns.setupStep(W, id, "first", { type: "email", touchClass: "cold", mailboxCredentialId: mailbox, audience: "everyone", dependsOnStepKey: "second" }));
    await write(id, { subject: LINKED.subject, text });
    await addPeople(id, [person({ first: "Kim" })]);
    ok(await campaigns.recordOutput(W, id, "second", "https://acme.test/launch", actor));
    const [one] = await made(id);
    expect((await approve({ id: one!.itemId! })).status).toBe(200);
    return { id, itemId: one!.itemId!, action: await actionOf(one!.itemId!) };
  }

  test("an approved email using the URL sends while the URL stands", async () => {
    const { action } = await approvedLinked();
    expect(await sendsAtSlot(action)).toBe(1);
  });

  test("changing the URL holds an approved email that used it, and sends nothing", async () => {
    const { id, itemId, action } = await approvedLinked();
    ok(await campaigns.recordOutput(W, id, "second", "https://acme.test/launch-v2", actor));
    expect(await sendsAtSlot(action)).toBe(0);
    expect(await holdOf(action)).toMatchObject({ state: "held", hold_reason: "snapshot_changed", hold_detail: `step_output:campaign:${id}:step:second` });
    expect(await items.view(W, itemId)).toMatchObject({ state: "held" });
  });

  test("an email whose text doesn't use the URL isn't held when it changes", async () => {
    const { id, action } = await approvedLinked("Hello {{firstName}}, no link here.");
    ok(await campaigns.recordOutput(W, id, "second", "https://acme.test/launch-v2", actor));
    expect(await sendsAtSlot(action)).toBe(1);
  });

  test("only the step it waits on may be named, and a list value naming a step stays as written", async () => {
    const id = await linked();
    expect(await campaigns.saveTemplate(W, id, "first", { revision: 1, subject: "Hi", text: "{{steps.first.url}}", userId: owner })).toEqual({ ok: false, reason: "unknown_merge_field" });
    const unlinked = await ready();
    expect(await campaigns.saveTemplate(W, unlinked, "first", { revision: 0, subject: "Hi", text: "{{steps.second.url}}", userId: owner })).toEqual({ ok: false, reason: "unknown_merge_field" });

    await addPeople(id, [person({ first: "{{steps.second.url}}" })]);
    ok(await campaigns.recordOutput(W, id, "second", "https://acme.test/launch", actor));
    expect(ok(await campaigns.previewDrafts(W, id, "first")).sample).toMatchObject({ subject: "Hi {{steps.second.url}}", text: "See https://acme.test/launch, {{steps.second.url}}." });
  });
});

test("a setup change and a saved template are each told once, after they commit, and refusals are not", async () => {
  hooked.length = 0;
  const id = await ready();
  expect(hooked).toEqual([{ setup: { workspaceId: W, campaignId: id } }, { setup: { workspaceId: W, campaignId: id } }]);
  hooked.length = 0;
  await write(id);
  expect(hooked).toEqual([{ saved: { workspaceId: W, campaignId: id, stepKey: "first", revision: 1, userId: owner } }]);
  hooked.length = 0;
  expect((await campaigns.saveTemplate(W, id, "first", { revision: 0, ...TEMPLATE, userId: owner })).ok).toBe(false);
  expect(hooked).toEqual([]);
});

test("a template a run wrote carries a later warning into the drafts made from it, unless a person saved over it", async () => {
  const run = crypto.randomUUID();
  const kept = await ready();
  await write(kept);
  await q("update campaign_steps set draft_run_id = $1 where campaign_id = $2 and step_key = 'first'", [run, kept]);
  const edited = await ready();
  await write(edited);
  await q("update campaign_steps set draft_run_id = $1 where campaign_id = $2 and step_key = 'first'", [run, edited]);
  await write(edited, { ...TEMPLATE, text: "Hello {{firstName}}, from {{senderName}}." }, 1);
  await campaigns.warnTemplates(W, [run], "Written with a lesson that was later withdrawn.");
  for (const id of [kept, edited]) await addPeople(id, [person()]);
  const said = async (id: string) => (await items.view(W, (await made(id))[0]!.itemId!))!.warnings.map((w) => w.text);
  expect(await said(kept)).toContain("Written with a lesson that was later withdrawn.");
  expect(await said(edited)).not.toContain("Written with a lesson that was later withdrawn.");
});

test("concurrent mailbox saves keep the primary consistent with retained order", async () => {
  const a = await newCredential(`${crypto.randomUUID()}@acme.test`, "google");
  const b = await newCredential(`${crypto.randomUUID()}@acme.test`, "google");
  const id = await ready();
  const setup = { type: "email", touchClass: "cold", audience: "everyone" } as const;
  ok(await campaigns.setupStep(W, id, "first", { ...setup, mailboxCredentialIds: [] }));
  const locker = await appClient();
  await locker.query("begin");
  await locker.query("select set_config('app.workspace_id', $1, true)", [W]);
  await locker.query("select 1 from campaign_steps where campaign_id = $1 and step_key = 'first' for update", [id]);
  const saves = [
    campaigns.setupStep(W, id, "first", { ...setup, mailboxCredentialIds: [a, b] }),
    campaigns.setupStep(W, id, "first", { ...setup, mailboxCredentialIds: [b, a] }),
  ];
  try {
    // Hold both saves at the same row lock, then let them finish in database order.
    let waiting = 0;
    for (let i = 0; i < 100 && waiting < 2; i++) {
      waiting = Number((await q("select count(*) as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%campaign_steps%'"))[0].n);
      if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(2);
  } finally {
    await locker.query("rollback");
    await locker.end();
    for (const result of await Promise.all(saves)) ok(result);
  }
  const rows = await q("select s.mailbox_credential_id, m.credential_id from campaign_steps s join campaign_step_mailboxes m using (workspace_id, campaign_id, step_key) where s.campaign_id = $1 and s.step_key = 'first' order by m.added_at, m.credential_id", [id]);
  expect(rows).toHaveLength(2);
  expect(rows[0].mailbox_credential_id).toBe(rows[0].credential_id);
});

test("mailbox additions follow retained senders across saves and legacy settings preserve the set", async () => {
  const boxes: string[] = [];
  for (let i = 0; i < 3; i++) boxes.push(await newCredential(`${crypto.randomUUID()}@acme.test`, "google"));
  boxes.sort();
  const [added, primary, second] = boxes as [string, string, string];
  const id = await ready(primary);
  const setup = { type: "email", touchClass: "cold", audience: "everyone" } as const;
  const assigned = async () => (await q("select credential_id from campaign_step_mailboxes where campaign_id = $1 and step_key = 'first' order by added_at, credential_id", [id])).map((r) => r.credential_id);
  ok(await campaigns.setupStep(W, id, "first", { ...setup, mailboxCredentialIds: [primary, second] }));
  ok(await campaigns.setupStep(W, id, "first", { ...setup, mailboxCredentialIds: [added, second, primary] }));
  expect(await assigned()).toEqual([primary, second, added]);
  expect((await q("select mailbox_credential_id from campaign_steps where campaign_id = $1 and step_key = 'first'", [id]))[0].mailbox_credential_id).toBe(primary);
  ok(await campaigns.setupStep(W, id, "first", { ...setup, mailboxCredentialId: primary, audience: "no_reply_yet" }));
  expect(await assigned()).toEqual([primary, second, added]);
  expect((await campaigns.campaign(W, id))?.steps.find((s) => s.key === "first")?.audience).toBe("no_reply_yet");
  ok(await campaigns.setupStep(W, id, "first", { ...setup, mailboxCredentialIds: [second] }));
  expect(await assigned()).toEqual([second]);
  ok(await campaigns.setupStep(W, id, "first", { ...setup, mailboxCredentialId: added }));
  expect(await assigned()).toEqual([added]);
  ok(await campaigns.setupStep(W, id, "first", { ...setup, mailboxCredentialId: null }));
  expect(await assigned()).toEqual([]);
});

test("a step shares its drafts across its Mailboxes, a Person's next step keeps their sender, and a save keeps each draft's", async () => {
  // Two fresh Mailboxes: the file's own is already busy that day, and the earliest free time wins.
  const [box, other] = [await newCredential(`${crypto.randomUUID()}@acme.test`, "google"), await newCredential(`${crypto.randomUUID()}@acme.test`, "google")];
  const id = await ready(box);
  const setup = { type: "email", touchClass: "cold", audience: "everyone" } as const;
  expect(await campaigns.setupStep(W, id, "first", { ...setup, mailboxCredentialId: box, mailboxCredentialIds: [other] })).toEqual({ ok: false, reason: "mailbox_twice" });
  expect(await campaigns.setupStep(W, id, "first", { ...setup, mailboxCredentialIds: [other, other] })).toEqual({ ok: false, reason: "duplicate_mailbox" });
  ok(await campaigns.setupStep(W, id, "first", { ...setup, mailboxCredentialIds: [box, other] }));
  // Saved again the other way round, each Mailbox keeps its place, so box stays the step's first.
  ok(await campaigns.setupStep(W, id, "first", { ...setup, mailboxCredentialIds: [other, box] }));
  expect((await q("select mailbox_credential_id from campaign_steps where campaign_id = $1 and step_key = 'first'", [id]))[0].mailbox_credential_id).toBe(box);
  const { revision } = await write(id);
  const people = await addPeople(id, [person(), person(), person(), person()]);
  const senderOf = async (itemId: string) => (await q("select a.credential_id from actions a join items i on i.action_id = a.id where i.id = $1", [itemId]))[0].credential_id as string;
  const first = new Map<string, string>();
  for (const r of await made(id)) first.set(r.personId, await senderOf(r.itemId!));
  // Two each, taking turns.
  expect([...first.values()].filter((m) => m === box)).toHaveLength(2);
  expect([...first.values()].filter((m) => m === other)).toHaveLength(2);

  // A new text revises every draft under the Mailbox it was written with.
  expect(ok(await campaigns.saveTemplate(W, id, "first", { revision, subject: "Hey {{firstName}}", text: "Hi {{firstName}}, from {{senderName}}.", userId: owner })).revised).toBe(4);
  for (const r of await made(id)) expect(await senderOf(r.itemId!)).toBe(first.get(r.personId));

  // The follow-up lists the Mailboxes the other way round, and each Person still hears from the same one.
  ok(await campaigns.setupStep(W, id, "second", { ...setup, mailboxCredentialIds: [other, box] }));
  ok(await campaigns.saveTemplate(W, id, "second", { revision: 0, ...TEMPLATE, userId: owner }));
  const second = ok(await campaigns.makeDrafts(W, id, "second", { timeZone: "UTC", userId: owner })).results;
  expect(second.map((r) => r.personId).sort()).toEqual([...people].sort());
  for (const r of second) expect(await senderOf(r.itemId!)).toBe(first.get(r.personId));
});
